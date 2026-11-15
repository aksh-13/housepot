import type { Db } from "@/db";
import type { Payments } from "@/providers/payments";
import { nextTermEnd } from "@/time";
import { logActivity } from "./activity";
import { activeMembers, getHouse, memberById } from "./houses";
import { choreBounty, memberBalance, transfer } from "./ledger";

export type CashOut = { refundedCents: number; manualCents: number; writtenOffCents: number };

/** Serialises work on one member or house for the rest of the transaction. */
async function lock(t: Db, key: string): Promise<void> {
  await t.query("select pg_advisory_xact_lock(hashtext($1))", [key]);
}

/**
 * Empties a member's balance. Money goes back to the cards that paid it in, newest payment first.
 * Anything above what they paid in (winnings), or that the card processor refuses, is queued for
 * the operator to send by e-Transfer. A debt is written off.
 */
export async function cashOutMember(
  db: Db,
  payments: Payments,
  a: { memberId: string; now: Date },
): Promise<CashOut> {
  const result: CashOut = { refundedCents: 0, manualCents: 0, writtenOffCents: 0 };
  const member = await memberById(db, a.memberId);
  if (!member) return result;
  const houseId = member.houseId;

  await db.tx(async (t) => {
    await lock(t, `member:${a.memberId}`);
    const balance = await memberBalance(t, a.memberId);
    if (balance === 0) return;

    if (balance < 0) {
      await transfer(t, {
        houseId,
        from: "external",
        to: { memberId: a.memberId },
        amountCents: -balance,
        kind: "writeoff",
      });
      result.writtenOffCents = -balance;
    } else {
      let remaining = balance;
      const paid = await t.query<{
        id: string;
        provider_ref: string;
        amount_cents: number;
        refunded_cents: number;
      }>(
        `select id, provider_ref, amount_cents, refunded_cents from payments
         where member_id = $1 and refunded_cents < amount_cents order by created_at desc, id`,
        [a.memberId],
      );
      for (const p of paid.rows) {
        if (remaining === 0) break;
        const amountCents = Math.min(remaining, p.amount_cents - p.refunded_cents);
        const refund = await payments.refund({
          providerRef: p.provider_ref,
          amountCents,
          idempotencyKey: `refund:${p.id}:${p.refunded_cents}`,
        });
        if (!refund.ok) continue;
        await t.query("update payments set refunded_cents = refunded_cents + $2 where id = $1", [
          p.id,
          amountCents,
        ]);
        await transfer(t, {
          houseId,
          from: { memberId: a.memberId },
          to: "external",
          amountCents,
          kind: "cashout_refund",
        });
        result.refundedCents += amountCents;
        remaining -= amountCents;
      }
      if (remaining > 0) {
        await t.query(
          "insert into manual_payouts (house_id, member_id, amount_cents, created_at) values ($1, $2, $3, $4)",
          [houseId, a.memberId, remaining, a.now],
        );
        await transfer(t, {
          houseId,
          from: { memberId: a.memberId },
          to: "external",
          amountCents: remaining,
          kind: "cashout_manual",
        });
        result.manualCents = remaining;
      }
    }
    await logActivity(t, { houseId, memberId: a.memberId, kind: "cashed_out", data: result, now: a.now });
  });
  return result;
}

/** Cashes the member out and removes them from the house and its rotation. */
export async function leaveHouse(
  db: Db,
  payments: Payments,
  a: { memberId: string; now: Date },
): Promise<void> {
  const member = await memberById(db, a.memberId);
  if (!member || member.status === "left") return;
  await db.tx(async (t) => {
    await cashOutMember(t, payments, a);
    await t.query("update members set status = 'left', auto_reload = false where id = $1", [a.memberId]);
    await t.query(
      "update turns set status = 'cancelled' where assignee_member_id = $1 and status = 'assigned'",
      [a.memberId],
    );
    await t.query("delete from close_votes where member_id = $1", [a.memberId]);
    await logActivity(t, { houseId: member.houseId, memberId: a.memberId, kind: "left", now: a.now });
  });
}

/**
 * End of term (or an early close): unclaimed bounties are shared out equally, everyone is cashed
 * out, and the pot restarts. Housemates pay a fresh deposit to rejoin the rotation.
 */
export async function settleHouse(
  db: Db,
  payments: Payments,
  a: { houseId: string; now: Date },
): Promise<void> {
  const house = await getHouse(db, a.houseId);
  if (!house) return;
  await db.tx(async (t) => {
    await lock(t, `house:${a.houseId}`);
    const active = await activeMembers(t, a.houseId);

    if (active.length > 0) {
      const chores = await t.query<{ id: string }>("select id from chores where house_id = $1", [a.houseId]);
      for (const chore of chores.rows) {
        const bounty = await choreBounty(t, chore.id);
        if (bounty <= 0) continue;
        const share = Math.floor(bounty / active.length);
        const oddCents = bounty - share * active.length;
        for (const [i, m] of active.entries()) {
          const amountCents = share + (i < oddCents ? 1 : 0);
          if (amountCents === 0) continue;
          await transfer(t, {
            houseId: a.houseId,
            from: { choreId: chore.id },
            to: { memberId: m.id },
            amountCents,
            kind: "escrow_return",
          });
        }
      }
    }

    await t.query("update turns set status = 'rolled' where house_id = $1 and status = 'open'", [a.houseId]);
    await t.query("update turns set status = 'cancelled' where house_id = $1 and status = 'assigned'", [
      a.houseId,
    ]);
    await t.query("update disputes set status = 'expired' where house_id = $1 and status = 'open'", [
      a.houseId,
    ]);

    const everyone = await t.query<{ id: string }>(
      "select id from members where house_id = $1 and status <> 'left' order by rotation_position",
      [a.houseId],
    );
    for (const m of everyone.rows) await cashOutMember(t, payments, { memberId: m.id, now: a.now });

    await t.query(
      "update members set status = 'pending', topup_requested_month = null where house_id = $1 and status = 'active'",
      [a.houseId],
    );
    await t.query("delete from close_votes where house_id = $1", [a.houseId]);
    await t.query("update houses set settlement_date = $2 where id = $1", [
      a.houseId,
      nextTermEnd(a.now, house.tz),
    ]);
    await logActivity(t, { houseId: a.houseId, kind: "settled", now: a.now });
  });
}

/** A vote to cash everyone out now. The pot closes when more than half of paid-up housemates agree. */
export async function voteClosePot(
  db: Db,
  payments: Payments,
  a: { memberId: string; now: Date },
): Promise<{ closed: boolean; votes: number; needed: number }> {
  const member = await memberById(db, a.memberId);
  if (!member) return { closed: false, votes: 0, needed: 0 };
  return db.tx(async (t) => {
    await lock(t, `house:${member.houseId}`);
    const active = (await activeMembers(t, member.houseId)).map((m) => m.id);
    if (active.includes(a.memberId)) {
      await t.query("insert into close_votes (house_id, member_id) values ($1, $2) on conflict do nothing", [
        member.houseId,
        a.memberId,
      ]);
    }
    const cast = await t.query<{ member_id: string }>(
      "select member_id from close_votes where house_id = $1",
      [member.houseId],
    );
    const votes = cast.rows.filter((r) => active.includes(r.member_id)).length;
    const needed = Math.floor(active.length / 2) + 1;
    if (votes < needed) return { closed: false, votes, needed };
    await settleHouse(t, payments, { houseId: member.houseId, now: a.now });
    return { closed: true, votes, needed };
  });
}

export async function closeVoteCount(db: Db, houseId: string): Promise<{ votes: string[]; needed: number }> {
  const active = (await activeMembers(db, houseId)).map((m) => m.id);
  const cast = await db.query<{ member_id: string }>(
    "select member_id from close_votes where house_id = $1",
    [houseId],
  );
  return {
    votes: cast.rows.map((r) => r.member_id).filter((id) => active.includes(id)),
    needed: Math.floor(active.length / 2) + 1,
  };
}

export type ManualPayoutView = {
  id: string;
  memberId: string;
  name: string;
  phone: string;
  houseName: string;
  amountCents: number;
  createdAt: Date;
};

/** e-Transfers the operator still has to send. */
export async function pendingManualPayouts(db: Db): Promise<ManualPayoutView[]> {
  const { rows } = await db.query<ManualPayoutView>(
    `select p.id, p.member_id as "memberId", coalesce(u.name, 'Housemate') as name, u.phone,
            h.name as "houseName", p.amount_cents as "amountCents", p.created_at as "createdAt"
     from manual_payouts p join members m on m.id = p.member_id join users u on u.id = m.user_id
     join houses h on h.id = p.house_id
     where p.sent_at is null order by p.created_at, p.id`,
  );
  return rows;
}

export async function markPayoutSent(db: Db, id: string, now: Date): Promise<void> {
  await db.query("update manual_payouts set sent_at = $2 where id = $1 and sent_at is null", [id, now]);
}
