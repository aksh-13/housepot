import type { Db } from "@/db";
import { logActivity } from "./activity";
import { memberById } from "./houses";
import { hasPendingSubmission, lockTurn, type TurnRow } from "./turns";

/**
 * Swapping turns. Chores rotate, so a turn is fixed once it is yours. Its owner can ask a housemate
 * to take it, and can offer to do one of that person's turns in exchange. Nothing moves until the
 * other person accepts: a turn cannot be dumped on someone. Until then it stays with its owner, so a
 * request is never a way past a deadline. No money moves.
 *
 * Team chores already go to anyone on the team (see assignTurn), so swaps are for one-person turns.
 */

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

type SwapRow = {
  id: string;
  house_id: string;
  turn_id: string;
  from_member_id: string;
  to_member_id: string;
  give_back_turn_id: string | null;
  status: string;
};

/** Why a turn cannot change hands right now, or null if it can. */
async function cannotMove(t: Db, turn: TurnRow | null, ownerId: string, now: Date): Promise<string | null> {
  if (!turn || turn.status !== "assigned") return "That turn is no longer waiting.";
  if (turn.team_id) return "Team chores already go to anyone on the team.";
  if (turn.assignee_member_id !== ownerId) return "That turn has already changed hands.";
  if (now.getTime() > turn.due_at.getTime()) return "That turn's deadline has passed.";
  if (await hasPendingSubmission(t, turn.id)) return "Proof for that turn is already with the house.";
  return null;
}

async function inOpenRequest(t: Db, turnId: string): Promise<boolean> {
  const { rows } = await t.query(
    "select 1 from swap_requests where status = 'open' and (turn_id = $1 or give_back_turn_id = $1)",
    [turnId],
  );
  return rows.length > 0;
}

export async function requestSwap(
  db: Db,
  a: { turnId: string; memberId: string; toMemberId: string; giveBackTurnId?: string; now: Date },
): Promise<{ ok: true; requestId: string } | Fail> {
  return db.tx(async (t) => {
    const me = await memberById(t, a.memberId);
    const to = await memberById(t, a.toMemberId);
    if (!me || me.status !== "active") return fail("Only housemates can do that.");
    if (!to || to.houseId !== me.houseId || to.status !== "active") return fail("Pick a housemate.");
    if (to.id === me.id) return fail("Pick someone else.");
    // Locks in chore order, so two swaps between the same people cannot wait on each other.
    const turns = await lockInOrder(
      t,
      [a.turnId, a.giveBackTurnId].filter((x): x is string => !!x),
    );
    const turn = turns.get(a.turnId) ?? null;
    if (!turn || turn.house_id !== me.houseId) return fail("That turn is no longer waiting.");
    const mine = await cannotMove(t, turn, me.id, a.now);
    if (mine) return fail(mine === "That turn has already changed hands." ? "It is not your turn." : mine);
    if (await inOpenRequest(t, turn.id)) return fail("You have already asked someone about this turn.");
    if (a.giveBackTurnId) {
      const back = turns.get(a.giveBackTurnId) ?? null;
      const theirs = await cannotMove(t, back, to.id, a.now);
      if (theirs)
        return fail(
          theirs === "That turn has already changed hands." ? `That is not ${to.name}'s turn.` : theirs,
        );
      if (back!.chore_id === turn.chore_id) return fail("Pick a different chore to do in exchange.");
      if (await inOpenRequest(t, back!.id)) return fail(`${to.name} has already been asked about that turn.`);
    }
    const { rows } = await t.query<{ id: string }>(
      `insert into swap_requests (house_id, turn_id, from_member_id, to_member_id, give_back_turn_id, created_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [me.houseId, turn.id, me.id, to.id, a.giveBackTurnId ?? null, a.now],
    );
    await logActivity(t, {
      houseId: me.houseId,
      memberId: me.id,
      kind: "swap_requested",
      data: { choreName: turn.chore_name, toName: to.name },
      now: a.now,
    });
    return { ok: true as const, requestId: rows[0].id };
  });
}

async function lockInOrder(t: Db, turnIds: string[]): Promise<Map<string, TurnRow>> {
  const { rows } = await t.query<{ id: string }>(
    "select t.id from turns t where t.id = any($1::uuid[]) order by t.chore_id, t.id",
    [turnIds],
  );
  const locked = new Map<string, TurnRow>();
  for (const r of rows) {
    const turn = await lockTurn(t, r.id);
    if (turn) locked.set(r.id, turn);
  }
  return locked;
}

async function readSwap(t: Db, id: string): Promise<SwapRow | null> {
  const { rows } = await t.query<SwapRow>(
    `select id, house_id, turn_id, from_member_id, to_member_id, give_back_turn_id, status
     from swap_requests where id::text = $1`,
    [id],
  );
  return rows[0] ?? null;
}

/** Moves a turn to someone else, remembering who the rotation gave it to. */
async function hand(t: Db, turnId: string, toMemberId: string): Promise<void> {
  await t.query(
    `update turns set rotation_member_id = coalesce(rotation_member_id, assignee_member_id),
       assignee_member_id = $2, reminded_morning_at = null, reminded_final_at = null
     where id = $1`,
    [turnId, toMemberId],
  );
}

/** The person asked says yes or no. */
export async function answerSwap(
  db: Db,
  a: { requestId: string; memberId: string; accept: boolean; now: Date },
): Promise<{ ok: true; accepted: boolean } | Fail> {
  return db.tx(async (t) => {
    const found = await readSwap(t, a.requestId);
    if (!found || found.status !== "open") return fail("That request is no longer open.");
    if (found.to_member_id !== a.memberId) return fail("That request is for someone else.");
    const turns = await lockInOrder(
      t,
      [found.turn_id, found.give_back_turn_id].filter((x): x is string => !!x),
    );
    const swap = await readSwap(t, a.requestId);
    if (!swap || swap.status !== "open") return fail("That request is no longer open.");
    const turn = turns.get(swap.turn_id) ?? null;
    const back = swap.give_back_turn_id ? (turns.get(swap.give_back_turn_id) ?? null) : null;

    if (!a.accept) {
      await t.query("update swap_requests set status = 'declined', decided_at = $2 where id = $1", [
        swap.id,
        a.now,
      ]);
      return { ok: true as const, accepted: false };
    }
    const from = await memberById(t, swap.from_member_id);
    const problem =
      (from?.status !== "active" ? "They are no longer in the house." : null) ??
      (await cannotMove(t, turn, swap.from_member_id, a.now)) ??
      (swap.give_back_turn_id ? await cannotMove(t, back, swap.to_member_id, a.now) : null);
    if (problem) {
      await t.query("update swap_requests set status = 'lapsed', decided_at = $2 where id = $1", [
        swap.id,
        a.now,
      ]);
      return fail(`Too late to swap: ${problem.charAt(0).toLowerCase()}${problem.slice(1)}`);
    }
    await hand(t, turn!.id, swap.to_member_id);
    if (back) await hand(t, back.id, swap.from_member_id);
    await t.query("update swap_requests set status = 'accepted', decided_at = $2 where id = $1", [
      swap.id,
      a.now,
    ]);
    const to = await memberById(t, swap.to_member_id);
    await logActivity(t, {
      houseId: swap.house_id,
      memberId: swap.to_member_id,
      kind: "swap_accepted",
      data: {
        choreName: turn!.chore_name,
        fromName: from?.name,
        toName: to?.name,
        ...(back ? { backChoreName: back.chore_name } : {}),
      },
      now: a.now,
    });
    return { ok: true as const, accepted: true };
  });
}

/** The asker changes their mind. */
export async function cancelSwap(
  db: Db,
  a: { requestId: string; memberId: string; now: Date },
): Promise<{ ok: true } | Fail> {
  const swap = await readSwap(db, a.requestId);
  if (!swap || swap.status !== "open") return fail("That request is no longer open.");
  if (swap.from_member_id !== a.memberId) return fail("Only the person who asked can cancel it.");
  await db.query(
    "update swap_requests set status = 'cancelled', decided_at = $2 where id = $1 and status = 'open'",
    [swap.id, a.now],
  );
  return { ok: true };
}

/** For the tick: requests whose turns are past their deadline, or no longer waiting, lapse. */
export async function lapseSwaps(db: Db, houseId: string, now: Date): Promise<number> {
  const { rowCount } = await db.query(
    `update swap_requests r set status = 'lapsed', decided_at = $2
     where r.house_id = $1 and r.status = 'open' and exists (
       select 1 from turns tn
       where tn.id in (r.turn_id, r.give_back_turn_id) and (tn.status <> 'assigned' or tn.due_at < $2)
     )`,
    [houseId, now],
  );
  return rowCount;
}

export type SwapView = {
  id: string;
  turnId: string;
  choreName: string;
  dueAt: Date;
  fromMemberId: string;
  fromName: string;
  toMemberId: string;
  toName: string;
  giveBack: { turnId: string; choreName: string; dueAt: Date } | null;
};

export async function openSwaps(db: Db, houseId: string): Promise<SwapView[]> {
  const { rows } = await db.query<{
    id: string;
    turn_id: string;
    chore_name: string;
    due_at: Date;
    from_member_id: string;
    from_name: string;
    to_member_id: string;
    to_name: string;
    back_turn_id: string | null;
    back_chore_name: string | null;
    back_due_at: Date | null;
  }>(
    `select r.id, r.turn_id, c.name as chore_name, tn.due_at,
            r.from_member_id, coalesce(fu.name, 'Housemate') as from_name,
            r.to_member_id, coalesce(tu.name, 'Housemate') as to_name,
            r.give_back_turn_id as back_turn_id, bc.name as back_chore_name, bt.due_at as back_due_at
     from swap_requests r
     join turns tn on tn.id = r.turn_id join chores c on c.id = tn.chore_id
     join members fm on fm.id = r.from_member_id join users fu on fu.id = fm.user_id
     join members tm on tm.id = r.to_member_id join users tu on tu.id = tm.user_id
     left join turns bt on bt.id = r.give_back_turn_id left join chores bc on bc.id = bt.chore_id
     where r.house_id = $1 and r.status = 'open' and tn.status = 'assigned'
     order by r.created_at`,
    [houseId],
  );
  return rows.map((r) => ({
    id: r.id,
    turnId: r.turn_id,
    choreName: r.chore_name,
    dueAt: r.due_at,
    fromMemberId: r.from_member_id,
    fromName: r.from_name,
    toMemberId: r.to_member_id,
    toName: r.to_name,
    giveBack:
      r.back_turn_id && r.back_chore_name && r.back_due_at
        ? { turnId: r.back_turn_id, choreName: r.back_chore_name, dueAt: r.back_due_at }
        : null,
  }));
}
