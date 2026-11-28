import type { Db } from "@/db";
import { logActivity } from "./activity";
import { memberById } from "./houses";
import { choreBounty, transfer } from "./ledger";
import { hasOverdueDebt } from "./settleup";

export type Result = { ok: true; payoutCents?: number } | { ok: false; error: string };

type TurnRow = {
  id: string;
  chore_id: string;
  house_id: string;
  assignee_member_id: string;
  /** Set when the turn belongs to a cleaning team. Then the assignee is not who it is waiting on. */
  team_id: string | null;
  team_name: string | null;
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
    `select t.id, t.chore_id, t.house_id, t.assignee_member_id, t.team_id, tm.name as team_name,
            t.due_at, t.status, c.name as chore_name, c.skip_price_cents, h.money_mode
     from turns t join chores c on c.id = t.chore_id join houses h on h.id = t.house_id
     left join teams tm on tm.id = t.team_id
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

/** A member who leaves with turns waiting on them is charged as if each one had expired. */
export async function expireWaitingTurnsOf(t: Db, memberId: string, now: Date): Promise<void> {
  const waiting = await t.query<{ id: string }>(
    // A team's turn is not waiting on any one person, so leaving does not expire it.
    "select id from turns where assignee_member_id = $1 and status = 'assigned' and team_id is null order by due_at",
    [memberId],
  );
  for (const row of waiting.rows) {
    const turn = await lockTurn(t, row.id);
    if (turn && turn.status === "assigned") await openTurn(t, turn, "miss", now);
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

/** Charges the assignee the chore's worth and opens the chore to the whole house. */
export async function openTurn(t: Db, turn: TurnRow, reason: "miss" | "dispute", now: Date): Promise<void> {
  if (turn.team_id) {
    // The whole team shares a miss equally. Odd cents fall on the first people in rotation order.
    const team = await t.query<{ id: string }>(
      "select id from members where team_id = $1 and status = 'active' order by rotation_position",
      [turn.team_id],
    );
    const share = team.rows.length ? Math.floor(turn.skip_price_cents / team.rows.length) : 0;
    const odd = team.rows.length ? turn.skip_price_cents - share * team.rows.length : 0;
    for (const [i, m] of team.rows.entries()) {
      const amountCents = share + (i < odd ? 1 : 0);
      if (amountCents === 0) continue;
      await transfer(t, {
        houseId: turn.house_id,
        from: { memberId: m.id },
        to: { choreId: turn.chore_id },
        amountCents,
        kind: "miss",
        turnId: turn.id,
      });
    }
  } else {
    await transfer(t, {
      houseId: turn.house_id,
      from: { memberId: turn.assignee_member_id },
      to: { choreId: turn.chore_id },
      amountCents: turn.skip_price_cents,
      kind: "miss",
      turnId: turn.id,
    });
  }
  await rollOlderOpenTurns(t, turn.chore_id, turn.id);
  await t.query(
    `update turns set status = 'open', opened_reason = $2, completed_by_member_id = null, completed_at = null,
       photo_id = null, payout_cents = 0 where id = $1`,
    [turn.id, reason],
  );
  await logActivity(t, {
    houseId: turn.house_id,
    memberId: turn.team_id ? null : turn.assignee_member_id,
    kind: reason === "miss" ? "missed" : "dispute_passed",
    data: {
      turnId: turn.id,
      choreName: turn.chore_name,
      amountCents: turn.skip_price_cents,
      ...(turn.team_name ? { teamName: turn.team_name } : {}),
    },
    now,
  });
}

/**
 * Gives a team chore's waiting turn to someone else on that team. Any housemate can do it: the
 * automatic spread is only a starting point, and houses sort out who does what among themselves.
 * It changes who is named and reminded. Who may do it, and who pays for a miss, stay with the team.
 */
export async function assignTurn(
  db: Db,
  a: { turnId: string; memberId: string; toMemberId: string; now: Date },
): Promise<{ ok: true } | { ok: false; error: string }> {
  return db.tx(async (t) => {
    const turn = await lockTurn(t, a.turnId);
    const actor = await memberById(t, a.memberId);
    if (!turn || !actor || actor.houseId !== turn.house_id || actor.status !== "active") {
      return fail("Only housemates can do that.");
    }
    if (turn.status !== "assigned") return fail("This turn is no longer waiting.");
    if (!turn.team_id) return fail("Only a team chore can be given to someone else.");
    const to = await memberById(t, a.toMemberId);
    if (!to || to.status !== "active" || to.teamId !== turn.team_id) {
      return fail(`Pick someone on ${turn.team_name ?? "that team"}.`);
    }
    if (to.id === turn.assignee_member_id) return { ok: true as const };
    await t.query("update turns set assignee_member_id = $2 where id = $1", [turn.id, to.id]);
    await logActivity(t, {
      houseId: turn.house_id,
      memberId: a.memberId,
      kind: "turn_assigned",
      data: { choreName: turn.chore_name, toName: to.name },
      now: a.now,
    });
    return { ok: true as const };
  });
}

type DoneArgs = { turnId: string; memberId: string; photoId: string; now: Date };

/** A turn can be marked done from this long before its deadline, and no earlier. */
export const DONE_OPENS_MS = 2 * 24 * 60 * 60_000;

/** The assignee finished their chore on time. A bounty left over from earlier misses is theirs. */
export async function markDone(db: Db, a: DoneArgs): Promise<Result> {
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
