import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createBill } from "@/domain/bills";
import { createChore, ensureTurns } from "@/domain/chores";
import { getHouse, joinHouse } from "@/domain/houses";
import { choreBounty, memberBalance } from "@/domain/ledger";
import { savePhoto } from "@/domain/photos";
import { leaveHouse, voteClosePot } from "@/domain/settlement";
import {
  debtsForUser,
  houseSquareUp,
  markDebtPaid,
  markDebtSent,
  minimalPayments,
  newDebtCode,
  PAY_WITHIN_MS,
  settleUpHouse,
  settleUpNow,
  settleUpWith,
  textDebtPaid,
  textDebtSent,
  textNewDebts,
} from "@/domain/settleup";
import { runTick } from "@/domain/tick";
import { claimBounty, missTurn } from "@/domain/turns";
import { fakePayments } from "@/providers/payments";
import { fakeSms } from "@/providers/sms";
import { diskStorage } from "@/providers/storage";
import { db, expireTurn, makeHouse, makeUser, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z"); // Wed noon Toronto; garbage is due Thu 21:00
const LATE = new Date("2026-11-13T02:00:01Z"); // one second past the deadline
const DEC_1 = new Date("2026-12-01T14:00:00Z"); // 9am Toronto on the 1st
const HOUR = 60 * 60_000;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const storage = diskStorage(mkdtempSync(path.join(tmpdir(), "housepot-settle-")));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const sms = fakeSms(db);
const payments = fakePayments();

let house: TestHouse;
let a: string;
let b: string;
let c: string;

beforeEach(async () => {
  await resetDb();
  house = await makeHouse(3, { moneyMode: "etransfer" });
  [a, b, c] = house.members.map((m) => m.memberId);
  const chore = await createChore(db, {
    houseId: house.houseId,
    memberId: a,
    name: "Garbage",
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    now: NOW,
  });
  if (!chore.ok) throw new Error(chore.error);
  await ensureTurns(db, house.houseId, NOW);
});

async function photo(memberId: string): Promise<string> {
  const r = await savePhoto(db, storage, {
    houseId: house.houseId,
    memberId,
    bytes: JPEG,
    contentType: "image/jpeg",
    now: NOW,
  });
  if (!r.ok) throw new Error(r.error);
  return r.photoId;
}

const waitingTurn = async () =>
  (await db.query("select id, assignee_member_id from turns where status = 'assigned'")).rows[0];
const openTurn = async () => (await db.query("select id from turns where status = 'open'")).rows[0];
const balances = async () => Promise.all([a, b, c].map((m) => memberBalance(db, m)));
const ledgerTotal = async () =>
  (await db.query("select coalesce(sum(amount_cents), 0)::int as t from ledger_entries")).rows[0].t;
const debts = async () =>
  (
    await db.query(
      "select from_member_id, to_member_id, amount_cents, status from debts order by amount_cents desc, to_member_id",
    )
  ).rows;
const texts = async () => (await db.query("select to_phone, body from sms_outbox order by id")).rows;

/** A lets the garbage expire (the first turn is always theirs) and B claims it. */
async function aSkipsBClaims(): Promise<void> {
  const turn = await waitingTurn();
  expect(turn.assignee_member_id).toBe(a);
  expect(await expireTurn(turn.id, NOW)).toEqual({ ok: true });
  expect(await claimBounty(db, { turnId: turn.id, memberId: b, photoId: await photo(b), now: NOW })).toEqual({
    ok: true,
    payoutCents: 500,
  });
}

describe("minimalPayments", () => {
  test("two losers and one winner need two payments", () => {
    expect(
      minimalPayments([
        { memberId: "a", cents: -500 },
        { memberId: "b", cents: -300 },
        { memberId: "c", cents: 800 },
      ]),
    ).toEqual([
      { fromMemberId: "a", toMemberId: "c", amountCents: 500 },
      { fromMemberId: "b", toMemberId: "c", amountCents: 300 },
    ]);
  });

  test("everyone at zero needs no payments", () => {
    expect(
      minimalPayments([
        { memberId: "a", cents: 0 },
        { memberId: "b", cents: 0 },
      ]),
    ).toEqual([]);
  });

  test("random houses always balance out in at most n - 1 payments", () => {
    for (let round = 0; round < 200; round++) {
      const n = 2 + (round % 7);
      const cents = Array.from({ length: n - 1 }, () => Math.floor(Math.random() * 4001) - 2000);
      cents.push(-cents.reduce((s, x) => s + x, 0));
      const balances = cents.map((x, i) => ({ memberId: `m${i}`, cents: x }));
      const pays = minimalPayments(balances);
      expect(pays.length).toBeLessThanOrEqual(n - 1);
      const after = new Map(balances.map((x) => [x.memberId, x.cents]));
      for (const p of pays) {
        expect(p.amountCents).toBeGreaterThan(0);
        after.set(p.fromMemberId, after.get(p.fromMemberId)! + p.amountCents);
        after.set(p.toMemberId, after.get(p.toMemberId)! - p.amountCents);
      }
      expect([...after.values()].every((x) => x === 0)).toBe(true);
    }
  });
});

test("debt codes look like HP-XXXX with no look-alike characters", () => {
  for (let i = 0; i < 100; i++) expect(newDebtCode()).toMatch(/^HP-[A-HJ-NP-Z2-9]{4}$/);
});

test("everyone in an e-Transfer house is active from the start, at $0, with no deposit", async () => {
  const { rows } = await db.query("select status from members where house_id = $1", [house.houseId]);
  expect(rows.map((r) => r.status)).toEqual(["active", "active", "active"]);
  expect(await balances()).toEqual([0, 0, 0]);
  expect((await getHouse(db, house.houseId))?.settlementDate).toBe("2026-12-01");
});

test("a chore expiring at $0 takes the balance below zero", async () => {
  const turn = await waitingTurn();
  expect(await expireTurn(turn.id, NOW)).toEqual({ ok: true });
  expect(await memberBalance(db, a)).toBe(-500);
});

test("a settle-up turns the scoreboard into one debt and brings everyone back to zero", async () => {
  await aSkipsBClaims();
  expect(await balances()).toEqual([-500, 500, 0]);

  const created = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  expect(created).toHaveLength(1);
  expect(await debts()).toEqual([{ from_member_id: a, to_member_id: b, amount_cents: 500, status: "owed" }]);
  expect(await balances()).toEqual([0, 0, 0]);
  expect(await ledgerTotal()).toBe(0);
  expect((await getHouse(db, house.houseId))?.settlementDate).toBe("2027-01-01");
});

test("an unclaimed bounty is shared out first, so the person who skipped pays everyone", async () => {
  const turn = await waitingTurn();
  await missTurn(db, { turnId: turn.id, now: LATE });
  const created = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  // $5 shared three ways is 167 + 167 + 166. A gets 167 back and owes the other two their shares.
  expect(created).toHaveLength(2);
  expect(await debts()).toEqual([
    { from_member_id: a, to_member_id: b, amount_cents: 167, status: "owed" },
    { from_member_id: a, to_member_id: c, amount_cents: 166, status: "owed" },
  ]);
  expect(await balances()).toEqual([0, 0, 0]);
  expect(await openTurn()).toBeUndefined();
  const choreId = (await db.query("select id from chores")).rows[0].id;
  expect(await choreBounty(db, choreId)).toBe(0);
});

test("a house where nobody won or lost creates no debts", async () => {
  expect(await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" })).toEqual([]);
  expect(await debts()).toEqual([]);
});

test("either person on a debt can mark it paid, without the other confirming", async () => {
  await aSkipsBClaims();
  const [debt] = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  const [ua, ub, uc] = house.members.map((m) => m.userId);

  // Cy is not part of this debt.
  expect(await markDebtPaid(db, { debtId: debt.id, via: "manual", userId: uc, now: DEC_1 })).toEqual({
    ok: false,
    error: "That is not your debt.",
  });
  expect((await debts())[0].status).toBe("owed");

  // Ana owes it. Her saying she paid is enough.
  const paid = await markDebtPaid(db, { debtId: debt.id, via: "manual", userId: ua, now: DEC_1 });
  expect(paid).toMatchObject({ ok: true, changed: true });
  expect((await debts())[0].status).toBe("paid");
  const again = await markDebtPaid(db, { debtId: debt.id, via: "manual", userId: ub, now: DEC_1 });
  expect(again).toMatchObject({ ok: true, changed: false });
  expect(await balances()).toEqual([0, 0, 0]);
});

test("the person being paid can also mark it paid", async () => {
  await aSkipsBClaims();
  const [debt] = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  const paid = await markDebtPaid(db, {
    debtId: debt.id,
    via: "manual",
    userId: house.members[1].userId,
    now: DEC_1,
  });
  expect(paid).toMatchObject({ ok: true, changed: true });
});

test("when the payer marks a debt paid, the other person is told and the payer is not", async () => {
  await aSkipsBClaims();
  const [debt] = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  const paid = await markDebtPaid(db, {
    debtId: debt.id,
    via: "manual",
    userId: house.members[0].userId,
    now: DEC_1,
  });
  if (!paid.ok) throw new Error(paid.error);
  await db.query("delete from sms_outbox");
  await textDebtPaid(sms, paid.debt, "https://housepot.test/settle", "payer");
  expect(await texts()).toEqual([
    {
      to_phone: house.members[1].phone,
      body: "Ana says they paid you $5 by e-Transfer. It is marked as paid. https://housepot.test/settle",
    },
  ]);
});

describe("settleUpNow", () => {
  test("any housemate can settle the house up straight away, with no vote", async () => {
    await aSkipsBClaims();
    const result = await settleUpNow(db, { houseId: house.houseId, memberId: c, now: NOW });
    if (!result.ok) throw new Error(result.error);
    expect(result.debts).toHaveLength(1);
    expect(await debts()).toEqual([
      { from_member_id: a, to_member_id: b, amount_cents: 500, status: "owed" },
    ]);
    expect(await balances()).toEqual([0, 0, 0]);
  });

  test("with nothing owed it does nothing at all", async () => {
    const before = (await getHouse(db, house.houseId))?.settlementDate;
    expect(await settleUpNow(db, { houseId: house.houseId, memberId: a, now: NOW })).toEqual({
      ok: false,
      error: "Everyone is square. There is nothing to settle.",
    });
    expect(await debts()).toEqual([]);
    expect((await getHouse(db, house.houseId))?.settlementDate).toBe(before);
    expect(
      (await db.query("select count(*)::int as n from activity where kind = 'settled_up'")).rows[0].n,
    ).toBe(0);
  });

  test("only an active housemate of that house can do it", async () => {
    await aSkipsBClaims();
    const other = await makeHouse(1, { moneyMode: "etransfer" });
    expect(
      await settleUpNow(db, { houseId: house.houseId, memberId: other.members[0].memberId, now: NOW }),
    ).toEqual({
      ok: false,
      error: "Only housemates can settle up.",
    });
    expect(await debts()).toEqual([]);
  });

  test("a card house cannot be settled this way", async () => {
    const card = await makeHouse(2, { moneyMode: "card" });
    expect(
      await settleUpNow(db, { houseId: card.houseId, memberId: card.members[0].memberId, now: NOW }),
    ).toEqual({
      ok: false,
      error: "Only houses that settle up by e-Transfer can do this.",
    });
  });
});

test("both people see the debt, from their own side", async () => {
  await aSkipsBClaims();
  await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  const forA = await debtsForUser(db, house.members[0].userId);
  const forB = await debtsForUser(db, house.members[1].userId);
  const forC = await debtsForUser(db, house.members[2].userId);
  expect(forA).toHaveLength(1);
  expect(forB).toHaveLength(1);
  expect(forC).toHaveLength(0);
  expect(forA[0]).toMatchObject({ fromName: "Ana", toName: "Ben", amountCents: 500 });
});

test("an overdue debt stops you claiming bounties until it is paid", async () => {
  await aSkipsBClaims();
  const [debt] = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  const afterDue = plus(DEC_1, PAY_WITHIN_MS + HOUR);
  // B misses next, so there is something for A to claim.
  await ensureTurns(db, house.houseId, afterDue);
  const next = (await db.query("select id, due_at from turns where status = 'assigned'")).rows[0];
  await missTurn(db, { turnId: next.id, now: plus(next.due_at, 1000) });
  const claimAt = plus(next.due_at, 2000);

  const refused = await claimBounty(db, {
    turnId: next.id,
    memberId: a,
    photoId: await photo(a),
    now: claimAt,
  });
  expect(refused).toEqual({
    ok: false,
    error: "You have a settle-up payment that is overdue. Pay it first, then you can claim.",
  });
  await markDebtPaid(db, { debtId: debt.id, via: "manual", userId: house.members[1].userId, now: claimAt });
  const allowed = await claimBounty(db, {
    turnId: next.id,
    memberId: a,
    photoId: await photo(a),
    now: claimAt,
  });
  expect(allowed.ok).toBe(true);
});

// The owner's call: housemates settle up when they choose to. Nothing turns balances into payment
// requests on a date, because some people take a long time to pay and should not be put on a clock
// they did not start.
test("the tick never settles an e-Transfer house up by itself", async () => {
  await aSkipsBClaims();
  await db.query("delete from sms_outbox");
  const onTheFirst = await runTick(db, { sms, payments }, DEC_1, "https://housepot.test");
  expect(onTheFirst).toMatchObject({ settled: 0, debtsCreated: 0 });
  expect(await balances()).toEqual([-500, 500, 0]);
  // A month on, still nothing. (Balances are not compared again: by then a chore turn has been missed.)
  const aMonthLater = await runTick(
    db,
    { sms, payments },
    plus(DEC_1, 31 * 24 * HOUR),
    "https://housepot.test",
  );
  expect(aMonthLater).toMatchObject({ settled: 0, debtsCreated: 0 });
  expect(await debts()).toEqual([]);
  expect((await texts()).filter((t) => /settle-up|you owe|owes you/.test(t.body))).toEqual([]);
});

test("settling up by hand still texts both sides and does not stop the house", async () => {
  await aSkipsBClaims();
  await db.query("delete from sms_outbox");
  const result = await settleUpNow(db, { houseId: house.houseId, memberId: a, now: DEC_1 });
  if (!result.ok) throw new Error(result.error);
  await textNewDebts(db, sms, result.debts, "https://housepot.test/settle");
  expect(await debts()).toHaveLength(1);

  const sent = await texts();
  const toA = sent.filter((t) => t.to_phone === house.members[0].phone).map((t) => t.body);
  const toB = sent.filter((t) => t.to_phone === house.members[1].phone).map((t) => t.body);
  expect(
    toA.some((body) => /You owe Ben \$5\. .*HP-[A-Z0-9]{4}.*https:\/\/housepot\.test\/settle/.test(body)),
  ).toBe(true);
  expect(toB.some((body) => body.includes("Ana owes you $5"))).toBe(true);
  // Members stay active: nobody has to pay back in, unlike a card house.
  const { rows } = await db.query("select status from members where house_id = $1", [house.houseId]);
  expect(rows.every((r) => r.status === "active")).toBe(true);
});

test("an unpaid debt gets one reminder after a day and one when it is overdue, never more", async () => {
  await aSkipsBClaims();
  await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  await db.query("delete from sms_outbox");
  const reminders = async () =>
    (await texts()).filter((t) => t.to_phone === house.members[0].phone && /owe|overdue/.test(t.body));

  const t = (ms: number) => runTick(db, { sms, payments }, plus(DEC_1, ms), "https://housepot.test");
  await t(HOUR);
  expect(await reminders()).toHaveLength(0);
  await t(25 * HOUR);
  await t(26 * HOUR);
  expect(await reminders()).toHaveLength(1);
  await t(PAY_WITHIN_MS + HOUR);
  await t(PAY_WITHIN_MS + 2 * HOUR);
  const all = await reminders();
  expect(all).toHaveLength(2);
  expect(all[1].body).toContain("overdue");
});

test("a debt marked as sent is not chased", async () => {
  await aSkipsBClaims();
  const [debt] = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  await markDebtSent(db, { debtId: debt.id, userId: house.members[0].userId, now: DEC_1 });
  await db.query("delete from sms_outbox");
  await runTick(db, { sms, payments }, plus(DEC_1, 30 * HOUR), "https://housepot.test");
  expect((await texts()).filter((x) => x.to_phone === house.members[0].phone)).toEqual([]);
});

test("leaving settles the house up, so the leaver's winnings become a debt owed to them", async () => {
  await aSkipsBClaims();
  const left = await leaveHouse(db, payments, { memberId: b, now: plus(NOW, 25 * HOUR) });
  expect(left).toMatchObject({ ok: true });
  expect(left.ok && left.debts).toHaveLength(1);
  expect(await debts()).toEqual([{ from_member_id: a, to_member_id: b, amount_cents: 500, status: "owed" }]);
  const { rows } = await db.query("select status from members where id = $1", [b]);
  expect(rows[0].status).toBe("left");
  // The debt outlives the membership: B still sees it.
  expect(await debtsForUser(db, house.members[1].userId)).toHaveLength(1);
  expect(payments.refunds).toEqual([]);
});

test("a majority vote settles up early", async () => {
  await aSkipsBClaims();
  expect(await voteClosePot(db, payments, { memberId: a, now: NOW })).toMatchObject({ closed: false });
  const result = await voteClosePot(db, payments, { memberId: c, now: NOW });
  expect(result).toMatchObject({ closed: true });
  expect(result.debts).toHaveLength(1);
  expect(await balances()).toEqual([0, 0, 0]);
});

test("someone who joins an e-Transfer house later is active straight away", async () => {
  const userId = await makeUser("Late");
  const joined = await joinHouse(db, { userId, inviteCode: house.inviteCode, now: NOW });
  expect(joined.ok).toBe(true);
  const { rows } = await db.query("select status from members where user_id = $1", [userId]);
  expect(rows[0].status).toBe("active");
});

test("with Interac checking off, the settle-up text does not mention an Interac request", async () => {
  await aSkipsBClaims();
  await db.query("update members set etransfer_email = 'ben@example.com' where id = $1", [b]);
  await db.query("delete from sms_outbox");
  process.env.INBOUND_EMAIL_PROVIDER = "off";
  try {
    const created = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
    await textNewDebts(db, sms, created, "https://housepot.test/settle");
  } finally {
    delete process.env.INBOUND_EMAIL_PROVIDER;
  }
  const toBen = (await texts()).filter((t) => t.to_phone === house.members[1].phone).map((t) => t.body);
  expect(toBen).toEqual(["Ana owes you $5 and has been asked to pay. https://housepot.test/settle"]);
});

test("with Interac checking off, the 'sent' text does not promise automatic checking", async () => {
  await aSkipsBClaims();
  const [debt] = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  const sent = await markDebtSent(db, { debtId: debt.id, userId: house.members[0].userId, now: DEC_1 });
  if (!sent.ok) throw new Error(sent.error);
  const toBen = async () =>
    (await texts()).filter((t) => t.to_phone === house.members[1].phone).map((t) => t.body);

  await db.query("delete from sms_outbox");
  await textDebtSent(sms, sent.debt, "https://housepot.test/settle");
  expect(await toBen()).toEqual([
    "Ana says they sent you $5 by e-Transfer. It is marked paid as soon as Interac's email reaches Housepot, or tap Received: https://housepot.test/settle",
  ]);

  await db.query("delete from sms_outbox");
  process.env.INBOUND_EMAIL_PROVIDER = "off";
  try {
    await textDebtSent(sms, sent.debt, "https://housepot.test/settle");
  } finally {
    delete process.env.INBOUND_EMAIL_PROVIDER;
  }
  expect(await toBen()).toEqual([
    "Ana says they sent you $5 by e-Transfer. When it lands, tap It arrived: https://housepot.test/settle",
  ]);
});

describe("houseSquareUp", () => {
  const bill = async (paidBy: string, totalCents: number) => {
    const r = await createBill(db, {
      houseId: house.houseId,
      actorMemberId: paidBy,
      input: { description: "Bill", totalCents, paidByMemberId: paidBy, sharerMemberIds: [a, b, c] },
      now: NOW,
    });
    if (!r.ok) throw new Error(r.error);
  };

  test("turns bills into the fewest payments", async () => {
    await bill(a, 9000);
    await bill(b, 3000);
    expect(await balances()).toEqual([5000, -1000, -4000]);
    expect(await houseSquareUp(db, house.houseId)).toEqual({
      lines: [
        { fromMemberId: c, toMemberId: a, amountCents: 4000, fromName: "Cy", toName: "Ana" },
        { fromMemberId: b, toMemberId: a, amountCents: 1000, fromName: "Ben", toName: "Ana" },
      ],
      unclaimedCents: 0,
    });
  });

  test("creates no debts and moves no money", async () => {
    await bill(a, 9000);
    const before = await balances();
    await houseSquareUp(db, house.houseId);
    expect(await debts()).toEqual([]);
    expect(await balances()).toEqual(before);
  });

  test("reports money still waiting on a chore", async () => {
    const turn = await waitingTurn();
    await expireTurn(turn.id, NOW);
    expect(await houseSquareUp(db, house.houseId)).toEqual({ lines: [], unclaimedCents: 500 });
    expect(await balances()).toEqual([-500, 0, 0]);
  });

  test("of an even house is empty", async () => {
    expect(await houseSquareUp(db, house.houseId)).toEqual({ lines: [], unclaimedCents: 0 });
  });
});

describe("settleUpWith", () => {
  const bill = async (paidBy: string, totalCents: number) => {
    const r = await createBill(db, {
      houseId: house.houseId,
      actorMemberId: paidBy,
      input: { description: "Bill", totalCents, paidByMemberId: paidBy, sharerMemberIds: [a, b, c] },
      now: NOW,
    });
    if (!r.ok) throw new Error(r.error);
  };
  // Ana is up $50, Ben is down $10, Cy is down $40: "Cy pays Ana $40" and "Ben pays Ana $10".
  const setUp = async () => {
    await bill(a, 9000);
    await bill(b, 3000);
    expect(await balances()).toEqual([5000, -1000, -4000]);
  };

  test("two people settle what is between them and nobody else is touched", async () => {
    await setUp();
    const result = await settleUpWith(db, {
      houseId: house.houseId,
      memberId: b,
      otherMemberId: a,
      now: NOW,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.debt).toMatchObject({ fromMemberId: b, toMemberId: a, amountCents: 1000 });
    expect(await debts()).toEqual([
      { from_member_id: b, to_member_id: a, amount_cents: 1000, status: "owed" },
    ]);
    expect(await balances()).toEqual([4000, 0, -4000]);
    expect(await ledgerTotal()).toBe(0);
    expect((await houseSquareUp(db, house.houseId)).lines).toEqual([
      { fromMemberId: c, toMemberId: a, amountCents: 4000, fromName: "Cy", toName: "Ana" },
    ]);
  });

  test("the person being paid can start it too", async () => {
    await setUp();
    const result = await settleUpWith(db, {
      houseId: house.houseId,
      memberId: a,
      otherMemberId: c,
      now: NOW,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.debt).toMatchObject({ fromMemberId: c, toMemberId: a, amountCents: 4000 });
    expect(await balances()).toEqual([1000, -1000, 0]);
  });

  test("it leaves bills editable and the monthly settle-up date alone", async () => {
    await setUp();
    const before = (await getHouse(db, house.houseId))?.settlementDate;
    await settleUpWith(db, { houseId: house.houseId, memberId: b, otherMemberId: a, now: NOW });
    expect((await getHouse(db, house.houseId))?.settlementDate).toBe(before);
    expect(
      (await db.query("select count(*)::int as n from bills where settled_at is not null")).rows[0].n,
    ).toBe(0);
  });

  test("it shows in the activity feed", async () => {
    await setUp();
    await settleUpWith(db, { houseId: house.houseId, memberId: b, otherMemberId: a, now: NOW });
    const { rows } = await db.query("select kind, member_id, data from activity where kind = 'settled_pair'");
    expect(rows).toEqual([
      { kind: "settled_pair", member_id: b, data: { fromName: "Ben", toName: "Ana", amountCents: 1000 } },
    ]);
  });

  test("two people with nothing between them cannot settle", async () => {
    await setUp();
    expect(
      await settleUpWith(db, { houseId: house.houseId, memberId: b, otherMemberId: c, now: NOW }),
    ).toEqual({
      ok: false,
      error: "There is nothing to settle between you two right now.",
    });
    expect(await debts()).toEqual([]);
    expect(await balances()).toEqual([5000, -1000, -4000]);
  });

  test("settling twice in a row does nothing the second time", async () => {
    await setUp();
    await settleUpWith(db, { houseId: house.houseId, memberId: b, otherMemberId: a, now: NOW });
    const again = await settleUpWith(db, { houseId: house.houseId, memberId: b, otherMemberId: a, now: NOW });
    expect(again.ok).toBe(false);
    expect(await debts()).toHaveLength(1);
  });

  test("only housemates of the house can settle, and only with each other", async () => {
    await setUp();
    const other = await makeHouse(1, { moneyMode: "etransfer" });
    const stranger = other.members[0].memberId;
    const refused = { ok: false, error: "Only housemates can settle up." };
    expect(
      await settleUpWith(db, { houseId: house.houseId, memberId: stranger, otherMemberId: a, now: NOW }),
    ).toEqual(refused);
    expect(
      await settleUpWith(db, { houseId: house.houseId, memberId: a, otherMemberId: stranger, now: NOW }),
    ).toEqual(refused);
    expect(
      await settleUpWith(db, { houseId: house.houseId, memberId: a, otherMemberId: a, now: NOW }),
    ).toEqual(refused);
    expect(await debts()).toEqual([]);
  });
});

// Found by a tester: someone who still owed another housemate was told "You are square".
test("the 'paid' message to the payer is about that one payment, not their whole balance", async () => {
  await aSkipsBClaims();
  const [debt] = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  const paid = await markDebtPaid(db, {
    debtId: debt.id,
    via: "manual",
    userId: house.members[1].userId,
    now: DEC_1,
  });
  if (!paid.ok) throw new Error(paid.error);
  await db.query("delete from sms_outbox");
  await textDebtPaid(sms, paid.debt, "https://housepot.test/settle");
  const toAna = (await texts()).filter((t) => t.to_phone === house.members[0].phone).map((t) => t.body);
  expect(toAna).toEqual(["Ben got your $5. That payment is done. https://housepot.test/settle"]);
});

describe("where to send the money is in the message itself", () => {
  const toAna = async () =>
    (await texts()).filter((t) => t.to_phone === house.members[0].phone).map((t) => t.body);
  const ask = async () => {
    await aSkipsBClaims();
    const debts = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "early" });
    await db.query("delete from sms_outbox");
    return debts;
  };

  test("a payment request names the other person's e-Transfer email", async () => {
    await db.query("update members set etransfer_email = 'ben@example.com' where id = $1", [b]);
    const created = await ask();
    await textNewDebts(db, sms, created, "https://housepot.test/settle");
    expect(await toAna()).toEqual([
      `You owe Ben $5. Send an e-Transfer to ben@example.com and put ${created[0].code} in the message. https://housepot.test/settle`,
    ]);
  });

  test("when they have not added one yet, the request says so", async () => {
    const created = await ask();
    await textNewDebts(db, sms, created, "https://housepot.test/settle");
    expect(await toAna()).toEqual([
      `You owe Ben $5. Ben has not added an e-Transfer email yet, so ask where to send it. Put ${created[0].code} in the message. https://housepot.test/settle`,
    ]);
  });

  test("reminders name the e-Transfer email too", async () => {
    await db.query("update members set etransfer_email = 'ben@example.com' where id = $1", [b]);
    const created = await ask();
    const code = created[0].code;
    await runTick(db, { sms, payments }, plus(DEC_1, 25 * HOUR), "https://housepot.test");
    await runTick(db, { sms, payments }, plus(DEC_1, PAY_WITHIN_MS + HOUR), "https://housepot.test");
    expect((await toAna()).filter((body) => /owe|overdue/.test(body))).toEqual([
      `You still owe Ben $5. Send an e-Transfer to ben@example.com and put ${code} in the message. https://housepot.test/settle`,
      `Your $5 to Ben is overdue. You cannot win chore money until it is paid. Send an e-Transfer to ben@example.com and put ${code} in the message. https://housepot.test/settle`,
    ]);
  });
});
