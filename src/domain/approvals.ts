import type { Db } from "@/db";
import { logActivity } from "./activity";
import { activeMembers, memberById } from "./houses";
import { availableBounty, choreBounty, transfer } from "./ledger";
import { hasOverdueDebt } from "./settleup";
import {
  DONE_OPENS_MS,
  hasPendingSubmission,
  lockTurn,
  openTurn,
  rollOlderOpenTurns,
  type TurnRow,
} from "./turns";

/**
 * Finishing a chore takes proof and the house's say-so. Whoever did it sends one to four photos;
 * the chore then waits for the rest of the house. More than half of the other housemates saying
 * "Looks done" approves it, and only then does it count and does any money move. More than half
 * saying "Not done" rejects it. If neither happens within 48 hours, it counts: one housemate who
 * never opens the app must not hold up everyone else's money.
 *
 * Proof sent before the deadline is on time, however long the vote takes.
 */

export const MAX_PHOTOS = 4;
export const APPROVAL_WINDOW_MS = 48 * 60 * 60_000;

const NO_PHOTO = "Add a photo of the finished chore.";

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

export type Decision = "approved" | "rejected" | "pending";
export type SubmitResult =
  | { ok: true; submissionId: string; decision: Decision; payoutCents: number; choreName: string }
  | Fail;
export type VoteResult =
  | {
      ok: true;
      decision: Decision;
      payoutCents: number;
      submitterMemberId: string;
      choreName: string;
      kind: "done" | "claim";
    }
  | Fail;

type SubmissionRow = {
  id: string;
  turn_id: string;
  house_id: string;
  member_id: string;
  kind: "done" | "claim";
  status: string;
  reserved_cents: number;
  submitted_at: Date;
};

/** The photos must be this house's, one to four of them, and not the same photo twice. */
async function checkPhotos(t: Db, photoIds: string[], houseId: string): Promise<string | null> {
  const ids = [...new Set(photoIds.filter(Boolean))];
  if (ids.length === 0) return NO_PHOTO;
  if (ids.length > MAX_PHOTOS) return `Send up to ${MAX_PHOTOS} photos.`;
  const { rows } = await t.query("select id from photos where id = any($1::uuid[]) and house_id = $2", [
    ids,
    houseId,
  ]);
  return rows.length === ids.length ? null : NO_PHOTO;
}

async function insertSubmission(
  t: Db,
  a: {
    turn: TurnRow;
    memberId: string;
    kind: "done" | "claim";
    photoIds: string[];
    reservedCents: number;
    now: Date;
  },
): Promise<string> {
  const { rows } = await t.query<{ id: string }>(
    `insert into submissions (turn_id, house_id, member_id, kind, reserved_cents, submitted_at)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [a.turn.id, a.turn.house_id, a.memberId, a.kind, a.reservedCents, a.now],
  );
  const id = rows[0].id;
  for (const [position, photoId] of [...new Set(a.photoIds)].entries()) {
    await t.query("insert into submission_photos (submission_id, photo_id, position) values ($1, $2, $3)", [
      id,
      photoId,
      position,
    ]);
  }
  await logActivity(t, {
    houseId: a.turn.house_id,
    memberId: a.memberId,
    kind: "proof_sent",
    data: { turnId: a.turn.id, choreName: a.turn.chore_name, photoId: a.photoIds[0], kind: a.kind },
    now: a.now,
  });
  return id;
}

/** Who votes on a submission: every active housemate except whoever sent it. */
async function tally(t: Db, sub: SubmissionRow) {
  const voters = (await activeMembers(t, sub.house_id))
    .filter((m) => m.id !== sub.member_id)
    .map((m) => m.id);
  const { rows } = await t.query<{ member_id: string; approve: boolean }>(
    "select member_id, approve from approval_votes where submission_id = $1",
    [sub.id],
  );
  const votes: Record<string, boolean> = {};
  for (const r of rows) if (voters.includes(r.member_id)) votes[r.member_id] = r.approve;
  const yes = Object.values(votes).filter(Boolean).length;
  const no = Object.values(votes).filter((v) => !v).length;
  return { voters, votes, yes, no, needed: Math.floor(voters.length / 2) + 1 };
}

async function photoIdsOf(t: Db, submissionId: string): Promise<string[]> {
  const { rows } = await t.query<{ photo_id: string }>(
    "select photo_id from submission_photos where submission_id = $1 order by position",
    [submissionId],
  );
  return rows.map((r) => r.photo_id);
}

/** Pays out and closes the turn. Returns what the person was paid. */
async function approve(t: Db, sub: SubmissionRow, turn: TurnRow, now: Date): Promise<number> {
  const photoIds = await photoIdsOf(t, sub.id);
  // A done turn collects whatever is waiting on the chore that no claim has set aside. A claim
  // collects what was set aside for it, which is never more than the chore still holds.
  const payoutCents =
    sub.kind === "done"
      ? await availableBounty(t, turn.chore_id)
      : Math.min(sub.reserved_cents, await choreBounty(t, turn.chore_id));
  if (payoutCents > 0) {
    await transfer(t, {
      houseId: turn.house_id,
      from: { choreId: turn.chore_id },
      to: { memberId: sub.member_id },
      amountCents: payoutCents,
      kind: "bounty_payout",
      turnId: turn.id,
    });
  }
  if (sub.kind === "done" && payoutCents > 0) await rollOlderOpenTurns(t, turn.chore_id, turn.id);
  await t.query(
    `update turns set status = $2, completed_by_member_id = $3, completed_at = $4, photo_id = $5,
       payout_cents = $6 where id = $1`,
    [
      turn.id,
      sub.kind === "done" ? "done" : "claimed",
      sub.member_id,
      sub.submitted_at,
      photoIds[0],
      payoutCents,
    ],
  );
  await logActivity(t, {
    houseId: turn.house_id,
    memberId: sub.member_id,
    kind: sub.kind === "done" ? "done" : "claimed",
    data: { turnId: turn.id, choreName: turn.chore_name, photoId: photoIds[0], photoIds, payoutCents },
    now,
  });
  return payoutCents;
}

/**
 * A rejected "done" sent before the deadline can be sent again. Once the deadline has passed, the
 * chore expires as if nothing had been sent. A rejected claim just leaves the chore open.
 */
async function reject(t: Db, sub: SubmissionRow, turn: TurnRow, now: Date): Promise<void> {
  await logActivity(t, {
    houseId: turn.house_id,
    memberId: sub.member_id,
    kind: "proof_rejected",
    data: { turnId: turn.id, choreName: turn.chore_name },
    now,
  });
  if (sub.kind === "done" && now.getTime() > turn.due_at.getTime()) await openTurn(t, turn, "dispute", now);
}

/**
 * Settles a submission if it can be settled: by a majority, by the 48 hours running out, or because
 * there is nobody to ask. Must run with the chore and turn locked.
 */
async function decideIfReady(
  t: Db,
  sub: SubmissionRow,
  turn: TurnRow,
  now: Date,
): Promise<{ decision: Decision; payoutCents: number }> {
  const expected = sub.kind === "done" ? "assigned" : "open";
  if (turn.status !== expected) {
    // The chore was removed or rescheduled while the house was voting. Nothing to pay or charge.
    await t.query("update submissions set status = 'withdrawn', decided_at = $2 where id = $1", [
      sub.id,
      now,
    ]);
    return { decision: "rejected", payoutCents: 0 };
  }
  const { voters, yes, no, needed } = await tally(t, sub);
  const timedOut = now.getTime() - sub.submitted_at.getTime() >= APPROVAL_WINDOW_MS;
  let decision: Decision = "pending";
  let by: "votes" | "timeout" | "nobody_to_ask" = "votes";
  if (voters.length === 0) [decision, by] = ["approved", "nobody_to_ask"];
  else if (yes >= needed) decision = "approved";
  else if (no >= needed) decision = "rejected";
  else if (timedOut) [decision, by] = ["approved", "timeout"];
  if (decision === "pending") return { decision, payoutCents: 0 };

  await t.query("update submissions set status = $2, decided_at = $3, decided_by = $4 where id = $1", [
    sub.id,
    decision,
    now,
    by,
  ]);
  if (decision === "approved") return { decision, payoutCents: await approve(t, sub, turn, now) };
  await reject(t, sub, turn, now);
  return { decision, payoutCents: 0 };
}

async function readSubmission(t: Db, id: string): Promise<SubmissionRow | null> {
  const { rows } = await t.query<SubmissionRow>(
    `select id, turn_id, house_id, member_id, kind, status, reserved_cents, submitted_at
     from submissions where id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

type SubmitArgs = { turnId: string; memberId: string; photoIds: string[]; now: Date };

/** The turn's own person, or anyone on its team, sends proof that they did it. */
export async function submitDone(db: Db, a: SubmitArgs): Promise<SubmitResult> {
  return db.tx(async (t) => {
    const turn = await lockTurn(t, a.turnId);
    if (!turn || turn.status !== "assigned") return fail("This turn is no longer waiting.");
    if (turn.team_id) {
      const doer = await memberById(t, a.memberId);
      if (!doer || doer.status !== "active" || doer.teamId !== turn.team_id) {
        return fail(`This one belongs to ${turn.team_name ?? "another team"}.`);
      }
    } else if (turn.assignee_member_id !== a.memberId) return fail("It is not your turn.");
    if (a.now.getTime() > turn.due_at.getTime()) return fail("The deadline has passed.");
    // Doing it the evening before is fine. Doing next week's turn today is not: it would also
    // collect money waiting on this week's still-open turn of the same chore.
    if (a.now.getTime() < turn.due_at.getTime() - DONE_OPENS_MS) {
      return fail("This is not due yet. You can mark it done from two days before the deadline.");
    }
    if (await hasPendingSubmission(t, turn.id)) return fail("Your proof is already with the house.");
    const photoError = await checkPhotos(t, a.photoIds, turn.house_id);
    if (photoError) return fail(photoError);

    const id = await insertSubmission(t, {
      turn,
      memberId: a.memberId,
      kind: "done",
      photoIds: a.photoIds,
      reservedCents: 0,
      now: a.now,
    });
    const sub = (await readSubmission(t, id))!;
    const { decision, payoutCents } = await decideIfReady(t, sub, turn, a.now);
    return { ok: true as const, submissionId: id, decision, payoutCents, choreName: turn.chore_name };
  });
}

/**
 * Anyone in the house does a chore that expired on someone else, and sends proof. The first proof
 * sent is the one the house votes on; the money waiting on the chore is set aside for it.
 */
export async function submitClaim(db: Db, a: SubmitArgs): Promise<SubmitResult> {
  return db.tx(async (t) => {
    const turn = await lockTurn(t, a.turnId);
    if (!turn) return fail("This chore is not open to claim.");
    const member = await memberById(t, a.memberId);
    if (!member || member.houseId !== turn.house_id || member.status !== "active") {
      return fail("Only paid-up housemates can claim.");
    }
    if (turn.status !== "open") return fail("This chore is not open to claim.");
    // Being late must cost something: whoever let it expire cannot do it late and take the money back.
    if (turn.team_id ? member.teamId === turn.team_id : turn.assignee_member_id === a.memberId) {
      return fail("This expired on you, so the money goes to whoever else does it.");
    }
    // In an e-Transfer house, not paying a settle-up debt on time means you cannot win any more
    // money until you do.
    if (await hasOverdueDebt(t, a.memberId, a.now)) {
      return fail("You have a settle-up payment that is overdue. Pay it first, then you can claim.");
    }
    if (await hasPendingSubmission(t, turn.id)) {
      return fail("Someone already sent proof for this. The house is voting on it.");
    }
    const photoError = await checkPhotos(t, a.photoIds, turn.house_id);
    if (photoError) return fail(photoError);

    const reservedCents = await availableBounty(t, turn.chore_id);
    const id = await insertSubmission(t, {
      turn,
      memberId: a.memberId,
      kind: "claim",
      photoIds: a.photoIds,
      reservedCents,
      now: a.now,
    });
    const sub = (await readSubmission(t, id))!;
    const { decision, payoutCents } = await decideIfReady(t, sub, turn, a.now);
    return { ok: true as const, submissionId: id, decision, payoutCents, choreName: turn.chore_name };
  });
}

/** "Looks done" (approve) or "Not done". A vote can be changed until the submission is decided. */
export async function voteOnSubmission(
  db: Db,
  a: { submissionId: string; memberId: string; approve: boolean; now: Date },
): Promise<VoteResult> {
  return db.tx(async (t) => {
    const found = await readSubmission(t, a.submissionId);
    if (!found) return fail("That proof does not exist.");
    const turn = await lockTurn(t, found.turn_id);
    // Re-read under the lock: another vote may have decided it while we waited.
    const sub = await readSubmission(t, a.submissionId);
    if (!turn || !sub || sub.status !== "pending") return fail("The house has already decided this one.");
    const member = await memberById(t, a.memberId);
    if (!member || member.houseId !== sub.house_id || member.status !== "active") {
      return fail("Only housemates can vote.");
    }
    if (sub.member_id === a.memberId) return fail("You cannot vote on your own chore.");
    await t.query(
      `insert into approval_votes (submission_id, member_id, approve, voted_at) values ($1, $2, $3, $4)
       on conflict (submission_id, member_id) do update set approve = excluded.approve, voted_at = excluded.voted_at`,
      [sub.id, a.memberId, a.approve, a.now],
    );
    const { decision, payoutCents } = await decideIfReady(t, sub, turn, a.now);
    return {
      ok: true as const,
      decision,
      payoutCents,
      submitterMemberId: sub.member_id,
      choreName: turn.chore_name,
      kind: sub.kind,
    };
  });
}

/** For the tick: settles every submission in the house whose 48 hours are up. Returns how many. */
export async function closeTimedOutSubmissions(db: Db, houseId: string, now: Date): Promise<number> {
  const { rows } = await db.query<{ id: string; turn_id: string }>(
    "select id, turn_id from submissions where house_id = $1 and status = 'pending' and submitted_at <= $2",
    [houseId, new Date(now.getTime() - APPROVAL_WINDOW_MS)],
  );
  let closed = 0;
  for (const row of rows) {
    const decided = await db.tx(async (t) => {
      const turn = await lockTurn(t, row.turn_id);
      const sub = await readSubmission(t, row.id);
      if (!turn || !sub || sub.status !== "pending") return false;
      return (await decideIfReady(t, sub, turn, now)).decision !== "pending";
    });
    if (decided) closed += 1;
  }
  return closed;
}

/** A member who has proof waiting on the house's vote. Leaving then would dodge the outcome. */
export async function hasPendingProof(db: Db, memberId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from submissions s join turns tn on tn.id = s.turn_id
     where s.member_id = $1 and s.status = 'pending' and tn.status in ('assigned', 'open')`,
    [memberId],
  );
  return rows.length > 0;
}

export type SubmissionView = {
  id: string;
  turnId: string;
  kind: "done" | "claim";
  choreName: string;
  memberId: string;
  memberName: string;
  photoIds: string[];
  submittedAt: Date;
  closesAt: Date;
  yes: number;
  no: number;
  needed: number;
  /** memberId -> true for "Looks done", false for "Not done" */
  votes: Record<string, boolean>;
  /** What the person gets if it is approved: set aside for a claim, waiting on the chore for a done. */
  payoutCents: number;
};

/** Everything in the house waiting on a vote, oldest first. */
export async function pendingSubmissions(db: Db, houseId: string): Promise<SubmissionView[]> {
  const { rows } = await db.query<
    SubmissionRow & { chore_name: string; chore_id: string; member_name: string }
  >(
    `select s.id, s.turn_id, s.house_id, s.member_id, s.kind, s.status, s.reserved_cents, s.submitted_at,
            c.name as chore_name, c.id as chore_id, coalesce(u.name, 'Housemate') as member_name
     from submissions s
     join turns tn on tn.id = s.turn_id join chores c on c.id = tn.chore_id
     join members m on m.id = s.member_id join users u on u.id = m.user_id
     where s.house_id = $1 and s.status = 'pending' and tn.status in ('assigned', 'open')
     order by s.submitted_at`,
    [houseId],
  );
  const views: SubmissionView[] = [];
  for (const r of rows) {
    const { votes, yes, no, needed } = await tally(db, r);
    views.push({
      id: r.id,
      turnId: r.turn_id,
      kind: r.kind,
      choreName: r.chore_name,
      memberId: r.member_id,
      memberName: r.member_name,
      photoIds: await photoIdsOf(db, r.id),
      submittedAt: r.submitted_at,
      closesAt: new Date(r.submitted_at.getTime() + APPROVAL_WINDOW_MS),
      yes,
      no,
      needed,
      votes,
      payoutCents: r.kind === "claim" ? r.reserved_cents : await availableBounty(db, r.chore_id),
    });
  }
  return views;
}
