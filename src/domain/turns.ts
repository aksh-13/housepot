import type { Db } from "@/db";
import { formatCents } from "@/money";
import { logActivity } from "./activity";
import { memberById } from "./houses";
import { choreBounty, memberBalance, transfer } from "./ledger";
import { hasOverdueDebt } from "./settleup";

export type Result = { ok: true; payoutCents?: number } | { ok: false; error: string };

type TurnRow = {
  id: string;
  chore_id: string;
  house_id: string;
  assignee_member_id: string;
  due_at: Date;
  status: string;
  chore_name: string;
  skip_price_cents: number;
  money_mode: "card" | "etransfer";
};

const NO_PHOTO = "Add a photo of the finished chore.";
const fail = (error: string): Result => ({ ok: false, error });

/** Reads a turn and locks it for the rest of the transaction, so two actions on it cannot interleave. */
async function lockTurn(t: Db, turnId: string): Promise<TurnRow | null> {
  await lockChoreOfTurn(t, turnId);
  const { rows } = await t.query<TurnRow>(
    `select t.id, t.chore_id, t.house_id, t.assignee_member_id, t.due_at, t.status,
            c.name as chore_name, c.skip_price_cents, h.money_mode
     from turns t join chores c on c.id = t.chore_id join houses h on h.id = t.house_id
     where t.id = $1 for update of t`,
    [turnId],
  );
  return rows[0] ?? null;
}

/**
 * Locks the chore for the rest of the transaction. A chore's bounty can be collected through two
 * different turns at once (the open one being claimed, and the next one being finished on time),
 * so everything that touches a turn takes this lock first. Always taken before any turn's own
 * lock, never after, so two actions can never end up waiting on each other.
 */
export async function lockChoreOfTurn(t: Db, turnId: string): Promise<void> {
  await t.query(
    "select c.id from chores c join turns tn on tn.chore_id = c.id where tn.id = $1 for update of c",
    [turnId],
  );
}

/** A member who leaves with turns waiting on them is charged as if they had skipped each one. */
export async function skipWaitingTurnsOf(t: Db, memberId: string, now: Date): Promise<void> {
  const waiting = await t.query<{ id: string }>(
    "select id from turns where assignee_member_id = $1 and status = 'assigned' order by due_at",
    [memberId],
  );
  for (const row of waiting.rows) {
    const turn = await lockTurn(t, row.id);
    if (turn && turn.status === "assigned") await openTurn(t, turn, "skip", now);
  }
}

async function photoBelongsTo(t: Db, photoId: string, houseId: string): Promise<boolean> {
  const { rows } = await t.query("select 1 from photos where id = $1 and house_id = $2", [photoId, houseId]);
  return rows.length > 0;
}

/** A chore has at most one open turn. Older ones step aside; their money stays on the chore. */
async function rollOlderOpenTurns(t: Db, choreId: string, exceptTurnId: string): Promise<void> {
  await t.query("update turns set status = 'rolled' where chore_id = $1 and status = 'open' and id <> $2", [
    choreId,
    exceptTurnId,
  ]);
}

/** Charges the assignee the skip price and opens the chore to the whole house. */
export async function openTurn(
  t: Db,
  turn: TurnRow,
  reason: "skip" | "miss" | "dispute",
  now: Date,
): Promise<void> {
  await transfer(t, {
    houseId: turn.house_id,
    from: { memberId: turn.assignee_member_id },
    to: { choreId: turn.chore_id },
    amountCents: turn.skip_price_cents,
    kind: reason === "skip" ? "skip" : "miss",
    turnId: turn.id,
  });
  await rollOlderOpenTurns(t, turn.chore_id, turn.id);
  await t.query(
    `update turns set status = 'open', opened_reason = $2, completed_by_member_id = null, completed_at = null,
       photo_id = null, payout_cents = 0 where id = $1`,
    [turn.id, reason],
  );
  await logActivity(t, {
    houseId: turn.house_id,
    memberId: turn.assignee_member_id,
    kind: reason === "skip" ? "skipped" : reason === "miss" ? "missed" : "dispute_passed",
    data: { turnId: turn.id, choreName: turn.chore_name, amountCents: turn.skip_price_cents },
    now,
  });
}

type DoneArgs = { turnId: string; memberId: string; photoId: string; now: Date };

/** The assignee finished their chore on time. A bounty left over from earlier misses is theirs. */
export async function markDone(db: Db, a: DoneArgs): Promise<Result> {
  return db.tx(async (t) => {
    const turn = await lockTurn(t, a.turnId);
    if (!turn || turn.status !== "assigned") return fail("This turn is no longer waiting.");
    if (turn.assignee_member_id !== a.memberId) return fail("It is not your turn.");
    if (a.now.getTime() > turn.due_at.getTime()) return fail("The deadline has passed.");
    if (!(await photoBelongsTo(t, a.photoId, turn.house_id))) return fail(NO_PHOTO);

    const payoutCents = await choreBounty(t, turn.chore_id);
    if (payoutCents > 0) {
      await transfer(t, {
        houseId: turn.house_id,
        from: { choreId: turn.chore_id },
        to: { memberId: a.memberId },
        amountCents: payoutCents,
        kind: "bounty_payout",
        turnId: turn.id,
      });
      await rollOlderOpenTurns(t, turn.chore_id, turn.id);
    }
    await t.query(
      `update turns set status = 'done', completed_by_member_id = $2, completed_at = $3, photo_id = $4,
         payout_cents = $5 where id = $1`,
      [turn.id, a.memberId, a.now, a.photoId, payoutCents],
    );
    await logActivity(t, {
      houseId: turn.house_id,
      memberId: a.memberId,
      kind: "done",
      data: { turnId: turn.id, choreName: turn.chore_name, photoId: a.photoId, payoutCents },
      now: a.now,
    });
    return { ok: true as const, payoutCents };
  });
}

type SkipArgs = { turnId: string; memberId: string; now: Date };

/** The assignee pays the skip price before the deadline instead of doing the chore. */
export async function payToSkip(db: Db, a: SkipArgs): Promise<Result> {
  return db.tx(async (t) => {
    const turn = await lockTurn(t, a.turnId);
    if (!turn || turn.status !== "assigned") return fail("This turn is no longer waiting.");
    if (turn.assignee_member_id !== a.memberId) return fail("It is not your turn.");
    if (a.now.getTime() > turn.due_at.getTime()) return fail("The deadline has passed.");
    // A card house only lets you skip with money you have paid in. In an e-Transfer house the
    // balance is a scoreboard, so skipping can take it below zero and the debt is settled later.
    if (turn.money_mode === "card" && (await memberBalance(t, a.memberId)) < turn.skip_price_cents) {
      return fail(
        `You need at least ${formatCents(turn.skip_price_cents)} in your balance to skip. Top up first.`,
      );
    }
    await openTurn(t, turn, "skip", a.now);
    return { ok: true as const };
  });
}

/** The deadline passed with nothing done. Charged even if the balance goes below zero. */
export async function missTurn(db: Db, a: { turnId: string; now: Date }): Promise<Result> {
  return db.tx(async (t) => {
    const turn = await lockTurn(t, a.turnId);
    if (!turn || turn.status !== "assigned") return fail("This turn is no longer waiting.");
    if (a.now.getTime() <= turn.due_at.getTime()) return fail("The deadline has not passed yet.");
    await openTurn(t, turn, "miss", a.now);
    return { ok: true as const };
  });
}

type ClaimArgs = { turnId: string; memberId: string; photoId: string; now: Date };

/**
 * Anyone in the house, including the person who skipped or missed, does an open chore and submits
 * a photo. The first claim wins everything waiting on the chore.
 */
export async function claimBounty(db: Db, a: ClaimArgs): Promise<Result> {
  return db.tx(async (t) => {
    await lockChoreOfTurn(t, a.turnId);
    const found = await t.query<{ house_id: string }>("select house_id from turns where id = $1", [a.turnId]);
    const houseId = found.rows[0]?.house_id;
    const member = await memberById(t, a.memberId);
    if (!houseId || !member || member.houseId !== houseId || member.status !== "active") {
      return fail("Only paid-up housemates can claim.");
    }
    // In an e-Transfer house, not paying a settle-up debt on time means you cannot win any more
    // money until you do.
    if (await hasOverdueDebt(t, a.memberId, a.now)) {
      return fail("You have a settle-up payment that is overdue. Pay it first, then you can claim.");
    }
    if (!(await photoBelongsTo(t, a.photoId, houseId))) return fail(NO_PHOTO);

    // Only one caller's update can match status = 'open'; the others see zero rows.
    const won = await t.query<{ chore_id: string }>(
      `update turns set status = 'claimed', completed_by_member_id = $2, completed_at = $3, photo_id = $4
       where id = $1 and status = 'open' returning chore_id`,
      [a.turnId, a.memberId, a.now, a.photoId],
    );
    if (won.rows.length === 0) return fail("This chore is not open to claim.");

    const choreId = won.rows[0].chore_id;
    const payoutCents = await choreBounty(t, choreId);
    if (payoutCents > 0) {
      await transfer(t, {
        houseId,
        from: { choreId },
        to: { memberId: a.memberId },
        amountCents: payoutCents,
        kind: "bounty_payout",
        turnId: a.turnId,
      });
    }
    await t.query("update turns set payout_cents = $2 where id = $1", [a.turnId, payoutCents]);
    const chore = await t.query<{ name: string }>("select name from chores where id = $1", [choreId]);
    await logActivity(t, {
      houseId,
      memberId: a.memberId,
      kind: "claimed",
      data: { turnId: a.turnId, choreName: chore.rows[0].name, photoId: a.photoId, payoutCents },
      now: a.now,
    });
    return { ok: true as const, payoutCents };
  });
}
