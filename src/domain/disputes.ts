import type { Db } from "@/db";
import { logActivity } from "./activity";
import { activeMembers, memberById } from "./houses";
import { transfer } from "./ledger";

export const DISPUTE_WINDOW_MS = 24 * 60 * 60_000;

type Fail = { ok: false; error: string };
type Passed = { passed: boolean; accusedMemberId: string; choreName: string };
export type RaiseResult = ({ ok: true; disputeId: string } & Passed) | Fail;
export type VoteResult = ({ ok: true } & Passed) | Fail;

type DisputedTurn = {
  id: string;
  chore_id: string;
  house_id: string;
  status: string;
  completed_by_member_id: string | null;
  completed_at: Date | null;
  payout_cents: number;
  chore_name: string;
  skip_price_cents: number;
};

const fail = (error: string): Fail => ({ ok: false, error });

async function lockTurn(t: Db, turnId: string): Promise<DisputedTurn | null> {
  const { rows } = await t.query<DisputedTurn>(
    `select t.id, t.chore_id, t.house_id, t.status, t.completed_by_member_id, t.completed_at, t.payout_cents,
            c.name as chore_name, c.skip_price_cents
     from turns t join chores c on c.id = t.chore_id where t.id = $1 for update of t`,
    [turnId],
  );
  return rows[0] ?? null;
}

/** Votes needed: more than half of the paid-up housemates other than the person disputed. */
async function tally(t: Db, disputeId: string, houseId: string, accusedId: string) {
  const others = (await activeMembers(t, houseId)).filter((m) => m.id !== accusedId).map((m) => m.id);
  const { rows } = await t.query<{ member_id: string; agree: boolean }>(
    "select member_id, agree from dispute_votes where dispute_id = $1",
    [disputeId],
  );
  const votes: Record<string, boolean> = {};
  for (const r of rows) if (others.includes(r.member_id)) votes[r.member_id] = r.agree;
  const agreeCount = Object.values(votes).filter(Boolean).length;
  return { votes, agreeCount, needed: Math.floor(others.length / 2) + 1 };
}

/** Undoes the disputed completion and puts the chore back up for grabs. */
async function applyPassedDispute(t: Db, disputeId: string, turn: DisputedTurn, now: Date): Promise<void> {
  const accused = turn.completed_by_member_id!;
  if (turn.payout_cents > 0) {
    await transfer(t, {
      houseId: turn.house_id,
      from: { memberId: accused },
      to: { choreId: turn.chore_id },
      amountCents: turn.payout_cents,
      kind: "dispute_reversal",
      turnId: turn.id,
    });
  }
  // A disputed on-time "done" is treated as a miss. A disputed claim only loses its payout.
  if (turn.status === "done") {
    await transfer(t, {
      houseId: turn.house_id,
      from: { memberId: accused },
      to: { choreId: turn.chore_id },
      amountCents: turn.skip_price_cents,
      kind: "miss",
      turnId: turn.id,
    });
  }
  const newerOpen = await t.query(
    "select 1 from turns where chore_id = $1 and status = 'open' and id <> $2",
    [turn.chore_id, turn.id],
  );
  await t.query(
    `update turns set status = $2, opened_reason = 'dispute', completed_by_member_id = null,
       completed_at = null, photo_id = null, payout_cents = 0 where id = $1`,
    [turn.id, newerOpen.rows.length > 0 ? "rolled" : "open"],
  );
  await t.query("update disputes set status = 'passed' where id = $1", [disputeId]);
  await logActivity(t, {
    houseId: turn.house_id,
    memberId: accused,
    kind: "dispute_passed",
    data: {
      turnId: turn.id,
      choreName: turn.chore_name,
      amountCents: turn.payout_cents + (turn.status === "done" ? turn.skip_price_cents : 0),
    },
    now,
  });
}

async function settle(t: Db, disputeId: string, turn: DisputedTurn, now: Date): Promise<Passed> {
  const accusedMemberId = turn.completed_by_member_id!;
  const { agreeCount, needed } = await tally(t, disputeId, turn.house_id, accusedMemberId);
  const passed = agreeCount >= needed;
  if (passed) await applyPassedDispute(t, disputeId, turn, now);
  return { passed, accusedMemberId, choreName: turn.chore_name };
}

type RaiseArgs = { turnId: string; memberId: string; now: Date };

/** A housemate says a finished chore was not really done. Raising it counts as their vote. */
export async function raiseDispute(db: Db, a: RaiseArgs): Promise<RaiseResult> {
  return db.tx(async (t) => {
    const turn = await lockTurn(t, a.turnId);
    if (!turn || !["done", "claimed"].includes(turn.status) || !turn.completed_at) {
      return fail("Only finished chores can be disputed.");
    }
    const member = await memberById(t, a.memberId);
    if (!member || member.houseId !== turn.house_id || member.status !== "active") {
      return fail("Only paid-up housemates can dispute.");
    }
    if (turn.completed_by_member_id === a.memberId) return fail("You cannot dispute your own chore.");
    if (a.now.getTime() - turn.completed_at.getTime() > DISPUTE_WINDOW_MS) {
      return fail("The 24 hours to dispute this have passed.");
    }
    const inserted = await t.query<{ id: string }>(
      `insert into disputes (turn_id, house_id, raised_by_member_id, accused_member_id, created_at)
       values ($1, $2, $3, $4, $5) on conflict (turn_id) do nothing returning id`,
      [turn.id, turn.house_id, a.memberId, turn.completed_by_member_id, a.now],
    );
    if (inserted.rows.length === 0) return fail("This has already been disputed.");
    const disputeId = inserted.rows[0].id;
    await t.query("insert into dispute_votes (dispute_id, member_id, agree) values ($1, $2, true)", [
      disputeId,
      a.memberId,
    ]);
    await logActivity(t, {
      houseId: turn.house_id,
      memberId: a.memberId,
      kind: "dispute_raised",
      data: { turnId: turn.id, choreName: turn.chore_name },
      now: a.now,
    });
    return { ok: true as const, disputeId, ...(await settle(t, disputeId, turn, a.now)) };
  });
}

type VoteArgs = { disputeId: string; memberId: string; agree: boolean; now: Date };

export async function voteDispute(db: Db, a: VoteArgs): Promise<VoteResult> {
  return db.tx(async (t) => {
    const found = await t.query<{ turn_id: string; status: string; accused_member_id: string }>(
      "select turn_id, status, accused_member_id from disputes where id = $1",
      [a.disputeId],
    );
    const dispute = found.rows[0];
    if (!dispute) return fail("That dispute does not exist.");
    const turn = await lockTurn(t, dispute.turn_id);
    // Re-read under the lock: another vote may have settled it while we waited.
    const current = await t.query<{ status: string }>("select status from disputes where id = $1", [
      a.disputeId,
    ]);
    if (!turn || current.rows[0].status !== "open" || !turn.completed_at) {
      return fail("This dispute is already closed.");
    }
    if (a.now.getTime() - turn.completed_at.getTime() > DISPUTE_WINDOW_MS) {
      await t.query("update disputes set status = 'expired' where id = $1", [a.disputeId]);
      return fail("The 24 hours to vote on this have passed.");
    }
    const member = await memberById(t, a.memberId);
    if (!member || member.houseId !== turn.house_id || member.status !== "active") {
      return fail("Only paid-up housemates can vote.");
    }
    if (dispute.accused_member_id === a.memberId) return fail("You cannot vote on your own chore.");
    await t.query(
      `insert into dispute_votes (dispute_id, member_id, agree) values ($1, $2, $3)
       on conflict (dispute_id, member_id) do update set agree = excluded.agree`,
      [a.disputeId, a.memberId, a.agree],
    );
    return { ok: true as const, ...(await settle(t, a.disputeId, turn, a.now)) };
  });
}

export type DisputeView = {
  id: string;
  turnId: string;
  choreName: string;
  accusedMemberId: string;
  accusedName: string;
  raisedByName: string;
  photoId: string | null;
  agreeCount: number;
  needed: number;
  /** memberId -> whether they agreed the chore was not done */
  votes: Record<string, boolean>;
  closesAt: Date;
};

/** Disputes still inside their 24-hour window. */
export async function openDisputes(db: Db, houseId: string, now: Date): Promise<DisputeView[]> {
  const { rows } = await db.query<{
    id: string;
    turn_id: string;
    chore_name: string;
    accused_member_id: string;
    accused_name: string;
    raised_by_name: string;
    photo_id: string | null;
    completed_at: Date;
  }>(
    `select d.id, d.turn_id, c.name as chore_name, d.accused_member_id,
            coalesce(au.name, 'Housemate') as accused_name, coalesce(ru.name, 'Housemate') as raised_by_name,
            t.photo_id, t.completed_at
     from disputes d
     join turns t on t.id = d.turn_id join chores c on c.id = t.chore_id
     join members am on am.id = d.accused_member_id join users au on au.id = am.user_id
     join members rm on rm.id = d.raised_by_member_id join users ru on ru.id = rm.user_id
     where d.house_id = $1 and d.status = 'open' and t.completed_at is not null
     order by d.created_at`,
    [houseId],
  );
  const views: DisputeView[] = [];
  for (const r of rows) {
    const closesAt = new Date(r.completed_at.getTime() + DISPUTE_WINDOW_MS);
    if (closesAt.getTime() < now.getTime()) continue;
    views.push({
      id: r.id,
      turnId: r.turn_id,
      choreName: r.chore_name,
      accusedMemberId: r.accused_member_id,
      accusedName: r.accused_name,
      raisedByName: r.raised_by_name,
      photoId: r.photo_id,
      ...(await tally(db, r.id, houseId, r.accused_member_id)),
      closesAt,
    });
  }
  return views;
}
