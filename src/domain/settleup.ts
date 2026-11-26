import { randomInt } from "node:crypto";
import type { Db } from "@/db";
import { formatCents } from "@/money";
import type { Sms } from "@/providers/sms";
import { inboundMode } from "@/settings";
import { nextMonthStart } from "@/time";
import { logActivity } from "./activity";
import { activeMembers, getHouse } from "./houses";
import { choreBounty, transfer } from "./ledger";

/**
 * Settling up in an e-Transfer house. No money is held by the app: balances are a scoreboard. Once a
 * month (or when someone leaves, or the house votes for it) the scoreboard is turned into a short
 * list of "A pays B" debts, the scoreboard goes back to zero, and housemates pay each other directly.
 */

/** How long a housemate has to pay after a settle-up before the debt counts as overdue. */
export const PAY_WITHIN_MS = 3 * 24 * 60 * 60_000;
/** The first reminder goes out this long after a settle-up, if the debt has not been sent. */
export const FIRST_REMINDER_MS = 24 * 60 * 60_000;

export type Payment = { fromMemberId: string; toMemberId: string; amountCents: number };

/**
 * The fewest simple payments that bring everyone to zero: the biggest debtor pays the biggest
 * winner, and so on. A house of n people needs at most n - 1 payments. Ties are broken by member id
 * so the answer is always the same for the same balances.
 */
export function minimalPayments(balances: { memberId: string; cents: number }[]): Payment[] {
  const order = (a: { memberId: string; cents: number }, b: { memberId: string; cents: number }) =>
    Math.abs(b.cents) - Math.abs(a.cents) || (a.memberId < b.memberId ? -1 : 1);
  const debtors = balances.filter((b) => b.cents < 0).map((b) => ({ ...b, cents: -b.cents }));
  const creditors = balances.filter((b) => b.cents > 0).map((b) => ({ ...b }));
  debtors.sort(order);
  creditors.sort(order);
  const payments: Payment[] = [];
  let d = 0;
  let c = 0;
  while (d < debtors.length && c < creditors.length) {
    const amountCents = Math.min(debtors[d].cents, creditors[c].cents);
    payments.push({ fromMemberId: debtors[d].memberId, toMemberId: creditors[c].memberId, amountCents });
    debtors[d].cents -= amountCents;
    creditors[c].cents -= amountCents;
    if (debtors[d].cents === 0) d += 1;
    if (creditors[c].cents === 0) c += 1;
  }
  return payments;
}

type Fail = { ok: false; error: string };

/**
 * Settles the house up right now, at any housemate's request. No vote: the "To square up" list has
 * already shown everyone what they would pay. Does nothing when nobody owes anything.
 */
export async function settleUpNow(
  db: Db,
  a: { houseId: string; memberId: string; now: Date },
): Promise<{ ok: true; debts: CreatedDebt[] } | Fail> {
  const house = await getHouse(db, a.houseId);
  if (!house || house.moneyMode !== "etransfer") {
    return { ok: false, error: "Only houses that settle up by e-Transfer can do this." };
  }
  if (!(await activeMembers(db, a.houseId)).some((m) => m.id === a.memberId)) {
    return { ok: false, error: "Only housemates can settle up." };
  }
  const { lines, unclaimedCents } = await houseSquareUp(db, a.houseId);
  if (lines.length === 0 && unclaimedCents === 0) {
    return { ok: false, error: "Everyone is square. There is nothing to settle." };
  }
  return { ok: true, debts: await settleUpHouse(db, { houseId: a.houseId, now: a.now, reason: "early" }) };
}

export type SquareUpLine = Payment & { fromName: string; toName: string };

/**
 * The fewest payments that would square the house up right now, for showing on the home screen.
 * It creates nothing and moves nothing: real debts are only made by a settle-up.
 *
 * Money waiting on a chore nobody has claimed belongs to no one yet, so it is reported separately
 * and the payments can add up to a little less than what people are down.
 */
export async function houseSquareUp(
  db: Db,
  houseId: string,
): Promise<{ lines: SquareUpLine[]; unclaimedCents: number }> {
  const [balances, unclaimed] = await Promise.all([
    db.query<{ memberId: string; name: string; cents: number }>(
      `select m.id as "memberId", coalesce(u.name, 'Housemate') as name,
              coalesce(sum(le.amount_cents), 0)::int as cents
       from members m join users u on u.id = m.user_id
       left join ledger_entries le on le.member_id = m.id
       where m.house_id = $1 and m.status <> 'left'
       group by m.id, u.name`,
      [houseId],
    ),
    db.query<{ cents: number }>(
      `select coalesce(sum(amount_cents), 0)::int as cents from ledger_entries
       where house_id = $1 and chore_id is not null`,
      [houseId],
    ),
  ]);
  const name = new Map(balances.rows.map((b) => [b.memberId, b.name]));
  const lines = minimalPayments(balances.rows).map((p) => ({
    ...p,
    fromName: name.get(p.fromMemberId) ?? "Housemate",
    toName: name.get(p.toMemberId) ?? "Housemate",
  }));
  return { lines, unclaimedCents: unclaimed.rows[0].cents };
}

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

/** "HP-7K3Q": short, typed into an e-Transfer message, no look-alike letters. */
export function newDebtCode(): string {
  let code = "HP-";
  for (let i = 0; i < 4; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

export type CreatedDebt = {
  id: string;
  fromMemberId: string;
  toMemberId: string;
  amountCents: number;
  code: string;
};

/**
 * Splits whatever is waiting on the house's chores equally between the active housemates. The odd
 * cents go to the first housemates in rotation order. The caller must hold the chore locks.
 */
export async function shareOutBounties(t: Db, houseId: string, choreIds: string[]): Promise<void> {
  const active = await activeMembers(t, houseId);
  if (active.length === 0) return;
  for (const choreId of choreIds) {
    const bounty = await choreBounty(t, choreId);
    if (bounty <= 0) continue;
    const share = Math.floor(bounty / active.length);
    const oddCents = bounty - share * active.length;
    for (const [i, m] of active.entries()) {
      const amountCents = share + (i < oddCents ? 1 : 0);
      if (amountCents === 0) continue;
      await transfer(t, {
        houseId,
        from: { choreId },
        to: { memberId: m.id },
        amountCents,
        kind: "escrow_return",
      });
    }
  }
}

export type SettleReason = "scheduled" | "early" | "leaving";

/**
 * Turns the scoreboard into debts. Unclaimed bounties are shared out first (open chores close, as
 * at the end of term in a card house), so balances add up to zero and every debt has someone to go
 * to. Each debt moves both balances back to zero in the ledger right away; the debt itself is then
 * paid outside the app. Turns waiting on someone are left alone: the rotation carries on.
 */
export async function settleUpHouse(
  db: Db,
  a: { houseId: string; now: Date; reason: SettleReason },
): Promise<CreatedDebt[]> {
  const house = await getHouse(db, a.houseId);
  if (!house || house.moneyMode !== "etransfer") return [];
  return db.tx(async (t) => {
    await t.query("select pg_advisory_xact_lock(hashtext($1))", [`house:${a.houseId}`]);
    // Chore locks before turn changes, like everywhere else, so this cannot deadlock with a claim.
    const chores = await t.query<{ id: string }>(
      "select id from chores where house_id = $1 order by id for update",
      [a.houseId],
    );
    await t.query("update turns set status = 'rolled' where house_id = $1 and status = 'open'", [a.houseId]);
    await shareOutBounties(
      t,
      a.houseId,
      chores.rows.map((c) => c.id),
    );

    const balances = await t.query<{ memberId: string; cents: number }>(
      `select m.id as "memberId", coalesce(sum(le.amount_cents), 0)::int as cents
       from members m left join ledger_entries le on le.member_id = m.id
       where m.house_id = $1 and m.status <> 'left'
       group by m.id`,
      [a.houseId],
    );
    const created: CreatedDebt[] = [];
    for (const p of minimalPayments(balances.rows)) {
      const debt = await insertDebt(t, a.houseId, p, new Date(a.now.getTime() + PAY_WITHIN_MS), a.now);
      // The winner's score goes down and the loser's goes up: both are now even, and the debt row
      // stands for the real money that still has to change hands.
      await transfer(t, {
        houseId: a.houseId,
        from: { memberId: p.toMemberId },
        to: { memberId: p.fromMemberId },
        amountCents: p.amountCents,
        kind: "settle_up",
        ref: `settle:${debt.id}`,
      });
      created.push(debt);
    }

    await t.query("delete from close_votes where house_id = $1", [a.houseId]);
    // Every bill so far is part of these debts now, so it can no longer be edited or deleted.
    await t.query(
      "update bills set settled_at = $2 where house_id = $1 and settled_at is null and deleted_at is null",
      [a.houseId, a.now],
    );
    await t.query("update houses set settlement_date = $2 where id = $1", [
      a.houseId,
      nextMonthStart(a.now, house.tz),
    ]);
    await logActivity(t, {
      houseId: a.houseId,
      kind: "settled_up",
      data: { reason: a.reason, payments: created.length },
      now: a.now,
    });
    return created;
  });
}

async function insertDebt(t: Db, houseId: string, p: Payment, dueAt: Date, now: Date): Promise<CreatedDebt> {
  // A clash on the random code is possible but rare; try again with another one.
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = newDebtCode();
    const { rows } = await t.query<{ id: string }>(
      `insert into debts (house_id, from_member_id, to_member_id, amount_cents, code, due_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7) on conflict (code) do nothing returning id`,
      [houseId, p.fromMemberId, p.toMemberId, p.amountCents, code, dueAt, now],
    );
    if (rows[0]) return { id: rows[0].id, ...p, code };
  }
  throw new Error("Could not find a free debt code");
}

export type DebtView = {
  id: string;
  houseId: string;
  houseName: string;
  amountCents: number;
  code: string;
  status: "owed" | "sent" | "paid";
  paidVia: "email" | "manual" | null;
  requestUrl: string | null;
  dueAt: Date;
  createdAt: Date;
  paidAt: Date | null;
  fromMemberId: string;
  fromName: string;
  fromEmail: string | null;
  fromBank: string | null;
  fromContact: string;
  fromUserId: string;
  toMemberId: string;
  toName: string;
  toEmail: string | null;
  toContact: string;
  toUserId: string;
};

const DEBT_SELECT = `select d.id, d.house_id as "houseId", h.name as "houseName", d.amount_cents as "amountCents",
    d.code, d.status, d.paid_via as "paidVia", d.request_url as "requestUrl", d.due_at as "dueAt",
    d.created_at as "createdAt", d.paid_at as "paidAt",
    d.from_member_id as "fromMemberId", coalesce(fu.name, 'Housemate') as "fromName",
    fm.etransfer_email as "fromEmail", fm.bank as "fromBank", coalesce(fu.email, fu.phone) as "fromContact", fu.id as "fromUserId",
    d.to_member_id as "toMemberId", coalesce(tu.name, 'Housemate') as "toName",
    tm.etransfer_email as "toEmail", coalesce(tu.email, tu.phone) as "toContact", tu.id as "toUserId"
  from debts d
  join houses h on h.id = d.house_id
  join members fm on fm.id = d.from_member_id join users fu on fu.id = fm.user_id
  join members tm on tm.id = d.to_member_id join users tu on tu.id = tm.user_id`;

export async function debtById(db: Db, debtId: string): Promise<DebtView | null> {
  const { rows } = await db.query<DebtView>(`${DEBT_SELECT} where d.id = $1`, [debtId]);
  return rows[0] ?? null;
}

/** Every debt this person pays or receives, across houses (they may have left one), newest first. */
export async function debtsForUser(db: Db, userId: string, limit = 50): Promise<DebtView[]> {
  const { rows } = await db.query<DebtView>(
    `${DEBT_SELECT} where fu.id = $1 or tu.id = $1
     order by (d.status = 'paid'), d.created_at desc, d.id limit $2`,
    [userId, limit],
  );
  return rows;
}

/** Unpaid debts in a house, oldest first. */
export async function unpaidDebts(db: Db, houseId: string): Promise<DebtView[]> {
  const { rows } = await db.query<DebtView>(
    `${DEBT_SELECT} where d.house_id = $1 and d.status <> 'paid' order by d.created_at, d.id`,
    [houseId],
  );
  return rows;
}

/** True when the member owes money that is past its due date. They cannot claim bounties until it is paid. */
export async function hasOverdueDebt(db: Db, memberId: string, now: Date): Promise<boolean> {
  const { rows } = await db.query(
    "select 1 from debts where from_member_id = $1 and status <> 'paid' and due_at < $2 limit 1",
    [memberId, now],
  );
  return rows.length > 0;
}

/** The payer says they have sent the e-Transfer. The receiver still has to see it arrive. */
export async function markDebtSent(
  db: Db,
  a: { debtId: string; userId: string; now: Date },
): Promise<{ ok: true; debt: DebtView } | Fail> {
  const debt = await debtById(db, a.debtId);
  if (!debt || debt.fromUserId !== a.userId) return { ok: false, error: "That is not your debt." };
  if (debt.status !== "owed") return { ok: false, error: "This one is already marked." };
  await db.tx(async (t) => {
    const changed = await t.query(
      "update debts set status = 'sent', sent_at = $2 where id = $1 and status = 'owed'",
      [a.debtId, a.now],
    );
    if (changed.rowCount === 0) return;
    await logActivity(t, {
      houseId: debt.houseId,
      memberId: debt.fromMemberId,
      kind: "debt_sent",
      data: { amountCents: debt.amountCents, toName: debt.toName },
      now: a.now,
    });
  });
  return { ok: true, debt };
}

/**
 * The debt is paid. Either one of the two people on it says so (manual), or Interac's email to the
 * receiver was matched (email). The payer's word is enough: the house runs on trust, the receiver
 * is told, and the activity feed shows it. Marking twice does nothing the second time.
 */
export async function markDebtPaid(
  db: Db,
  a: { debtId: string; via: "email" | "manual"; userId?: string; now: Date },
): Promise<{ ok: true; debt: DebtView; changed: boolean } | Fail> {
  const debt = await debtById(db, a.debtId);
  if (!debt) return { ok: false, error: "That debt does not exist." };
  if (a.via === "manual" && debt.toUserId !== a.userId && debt.fromUserId !== a.userId) {
    return { ok: false, error: "That is not your debt." };
  }
  const changed = await db.tx(async (t) => {
    const updated = await t.query(
      "update debts set status = 'paid', paid_via = $2, paid_at = $3 where id = $1 and status <> 'paid'",
      [a.debtId, a.via, a.now],
    );
    if (updated.rowCount === 0) return false;
    await logActivity(t, {
      houseId: debt.houseId,
      memberId: debt.fromMemberId,
      kind: "debt_paid",
      data: { amountCents: debt.amountCents, toName: debt.toName, via: a.via },
      now: a.now,
    });
    return true;
  });
  return { ok: true, debt, changed };
}

/** A text that fails to send must never undo the money side. */
async function send(sms: Sms, to: string, body: string): Promise<void> {
  try {
    await sms.send(to, body);
  } catch (err) {
    console.error(`Text to ${to} failed:`, err instanceof Error ? err.message : err);
  }
}

/** Tells both sides of each new debt what to do. */
export async function textNewDebts(db: Db, sms: Sms, debts: CreatedDebt[], link: string): Promise<void> {
  for (const created of debts) {
    const d = await debtById(db, created.id);
    if (!d) continue;
    const amount = formatCents(d.amountCents);
    await send(
      sms,
      d.fromContact,
      `Housepot settle-up: you owe ${d.toName} ${amount}. Pay by e-Transfer and put ${d.code} in the message: ${link}`,
    );
    await send(
      sms,
      d.toContact,
      inboundMode() === "off"
        ? `Housepot settle-up: ${d.fromName} owes you ${amount}. ${link}`
        : d.toEmail
          ? `Housepot settle-up: ${d.fromName} owes you ${amount}. Send them an Interac request to make it one tap: ${link}`
          : `Housepot settle-up: ${d.fromName} owes you ${amount}. Add your e-Transfer email so they can pay you: ${link}`,
    );
  }
}

/** Tells the person owed that the payer says the money is on its way. */
export async function textDebtSent(sms: Sms, d: DebtView, link: string): Promise<void> {
  const said = `${d.fromName} says they sent you ${formatCents(d.amountCents)} by e-Transfer.`;
  await send(
    sms,
    d.toContact,
    inboundMode() === "off"
      ? `${said} When it lands, tap It arrived: ${link}`
      : `${said} It is marked paid as soon as Interac's email reaches Housepot, or tap Received: ${link}`,
  );
}

/** Tells both sides a debt is cleared. */
export async function textDebtPaid(
  sms: Sms,
  d: DebtView,
  link: string,
  /** Who said so. The payer does not need a message about the button they just pressed. */
  by: "payer" | "receiver" = "receiver",
): Promise<void> {
  const amount = formatCents(d.amountCents);
  if (by === "payer") {
    await send(
      sms,
      d.toContact,
      `${d.fromName} says they paid you ${amount} by e-Transfer. It is marked as paid. ${link}`,
    );
    return;
  }
  await send(sms, d.fromContact, `${d.toName} got your ${amount}. You are square. ${link}`);
  await send(sms, d.toContact, `${d.fromName}'s ${amount} arrived. Marked as paid. ${link}`);
}
