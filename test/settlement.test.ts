import { beforeEach, expect, test } from "vitest";
import { createChore, ensureTurns } from "@/domain/chores";
import { activeMembers, getHouse, joinHouse, memberForUser } from "@/domain/houses";
import { choreBounty, memberBalance, transfer } from "@/domain/ledger";
import { applyPaymentEvent } from "@/domain/payments";
import {
  cashOutMember,
  leaveHouse,
  markPayoutSent,
  pendingManualPayouts,
  settleHouse,
  voteClosePot,
} from "@/domain/settlement";
import { missTurn } from "@/domain/turns";
import { type FakePayments, fakePayments } from "@/providers/payments";
import { db, makeHouse, makeUser, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z");
const LATE = new Date("2026-11-13T02:00:01Z");

let house: TestHouse;
let ids: string[];
let choreId: string;
let payments: FakePayments;

beforeEach(async () => {
  await resetDb();
  payments = fakePayments();
});

async function setup(size: number) {
  house = await makeHouse(size);
  ids = house.members.map((m) => m.memberId);
  const chore = await createChore(db, {
    houseId: house.houseId,
    memberId: ids[0],
    name: "Garbage",
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    now: NOW,
  });
  if (!chore.ok) throw new Error(chore.error);
  choreId = chore.choreId;
}

/** Moves money straight between two housemates' balances via the chore, as a skip and a payout would. */
async function shift(from: string, to: string, amountCents: number) {
  await transfer(db, {
    houseId: house.houseId,
    from: { memberId: from },
    to: { choreId },
    amountCents,
    kind: "skip",
  });
  await transfer(db, {
    houseId: house.houseId,
    from: { choreId },
    to: { memberId: to },
    amountCents,
    kind: "bounty_payout",
  });
}

const insideTheApp = async () =>
  (
    await db.query(
      "select coalesce(sum(amount_cents), 0)::int as n from ledger_entries where account_type <> 'external' and house_id = $1",
      [house.houseId],
    )
  ).rows[0].n;

test("winnings above what you paid in are sent by hand; the rest goes back to your card", async () => {
  await setup(2);
  await shift(ids[1], ids[0], 500); // ids[0] holds 2500, paid in 2000
  const r = await cashOutMember(db, payments, { memberId: ids[0], now: NOW });

  expect(r).toEqual({ refundedCents: 2000, manualCents: 500, writtenOffCents: 0 });
  expect(await memberBalance(db, ids[0])).toBe(0);
  expect(payments.refunds).toEqual([
    {
      providerRef: `test_deposit_${ids[0]}`,
      amountCents: 2000,
      idempotencyKey: expect.stringMatching(/^refund:/),
    },
  ]);
  expect(await pendingManualPayouts(db)).toMatchObject([
    { memberId: ids[0], name: "Ana", houseName: "Test House", amountCents: 500 },
  ]);
});

test("a balance below what you paid in is refunded in full to the card", async () => {
  await setup(2);
  await shift(ids[0], ids[1], 500); // ids[0] holds 1500
  const r = await cashOutMember(db, payments, { memberId: ids[0], now: NOW });
  expect(r).toEqual({ refundedCents: 1500, manualCents: 0, writtenOffCents: 0 });
  expect(await pendingManualPayouts(db)).toEqual([]);
  expect(
    (await db.query("select refunded_cents from payments where member_id = $1", [ids[0]])).rows[0]
      .refunded_cents,
  ).toBe(1500);
});

test("refunds go against the newest payment first", async () => {
  await setup(2);
  await shift(ids[0], ids[1], 700); // 1300
  await applyPaymentEvent(
    db,
    {
      type: "payment_succeeded",
      providerRef: "topup_1",
      memberId: ids[0],
      amountCents: 700,
      feeCents: 51,
      purpose: "topup",
    },
    new Date("2026-11-12T17:00:00Z"),
  ); // back to 2000
  await shift(ids[0], ids[1], 200); // 1800
  await cashOutMember(db, payments, { memberId: ids[0], now: LATE });
  expect(payments.refunds.map((r) => [r.providerRef, r.amountCents])).toEqual([
    ["topup_1", 700],
    [`test_deposit_${ids[0]}`, 1100],
  ]);
});

test("a refund the card processor refuses is paid by hand instead", async () => {
  await setup(1);
  await db.query("update payments set provider_ref = 'norefund_1' where member_id = $1", [ids[0]]);
  const r = await cashOutMember(db, payments, { memberId: ids[0], now: NOW });
  expect(r).toEqual({ refundedCents: 0, manualCents: 2000, writtenOffCents: 0 });
  expect(await memberBalance(db, ids[0])).toBe(0);
});

test("a debt is written off at cash-out", async () => {
  await setup(2);
  await shift(ids[0], ids[1], 2500); // ids[0] at -500
  const r = await cashOutMember(db, payments, { memberId: ids[0], now: NOW });
  expect(r).toEqual({ refundedCents: 0, manualCents: 0, writtenOffCents: 500 });
  expect(await memberBalance(db, ids[0])).toBe(0);
  expect(payments.refunds).toEqual([]);
});

test("cashing out twice at the same moment refunds once", async () => {
  await setup(1);
  await Promise.all([
    cashOutMember(db, payments, { memberId: ids[0], now: NOW }),
    cashOutMember(db, payments, { memberId: ids[0], now: NOW }),
  ]);
  expect(payments.refunds.reduce((sum, r) => sum + r.amountCents, 0)).toBe(2000);
  expect(await memberBalance(db, ids[0])).toBe(0);
});

test("marking a hand payout as sent takes it off the list", async () => {
  await setup(2);
  await shift(ids[1], ids[0], 500);
  await cashOutMember(db, payments, { memberId: ids[0], now: NOW });
  const [payout] = await pendingManualPayouts(db);
  await markPayoutSent(db, payout.id, LATE);
  expect(await pendingManualPayouts(db)).toEqual([]);
});

test("leaving cashes you out, counts your waiting turn as skipped, and the rotation carries on without you", async () => {
  await setup(3);
  await ensureTurns(db, house.houseId, NOW); // ids[0] is up
  await leaveHouse(db, payments, { memberId: ids[0], now: NOW });

  expect(await memberBalance(db, ids[0])).toBe(0);
  expect((await activeMembers(db, house.houseId)).map((m) => m.id)).toEqual([ids[1], ids[2]]);
  expect((await db.query("select status from turns")).rows).toEqual([{ status: "open" }]);
  expect(payments.refunds.map((r) => r.amountCents)).toEqual([1500]);
  expect(await memberForUser(db, house.members[0].userId)).toBeNull();

  await ensureTurns(db, house.houseId, NOW);
  const next = await db.query("select assignee_member_id from turns where status = 'assigned'");
  expect(next.rows[0].assignee_member_id).toBe(ids[1]);
});

test("someone who left can join a house again", async () => {
  await setup(2);
  await leaveHouse(db, payments, { memberId: ids[1], now: NOW });
  const again = await joinHouse(db, {
    userId: house.members[1].userId,
    inviteCode: house.inviteCode,
    now: LATE,
  });
  expect(again.ok).toBe(true);
  if (again.ok) expect(again.memberId).not.toBe(ids[1]);
});

test("settling hands unclaimed bounties back in equal shares, cashes everyone out, and restarts the pot", async () => {
  await setup(3);
  await ensureTurns(db, house.houseId, NOW);
  const turn = (await db.query("select id from turns where status = 'assigned'")).rows[0];
  await missTurn(db, { turnId: turn.id, now: LATE }); // ids[0] at 1500, bounty 500
  await ensureTurns(db, house.houseId, LATE);

  await settleHouse(db, payments, { houseId: house.houseId, now: new Date("2026-12-20T15:00:00Z") });

  // 500 split three ways: 167, 167, 166. Earlier rotation places get the odd cents.
  const refunded = Object.fromEntries(payments.refunds.map((r) => [r.providerRef, r.amountCents]));
  expect(refunded).toEqual({
    [`test_deposit_${ids[0]}`]: 1667,
    [`test_deposit_${ids[1]}`]: 2000,
    [`test_deposit_${ids[2]}`]: 2000,
  });
  expect((await pendingManualPayouts(db)).map((p) => [p.memberId, p.amountCents])).toEqual(
    expect.arrayContaining([
      [ids[1], 167],
      [ids[2], 166],
    ]),
  );
  for (const id of ids) expect(await memberBalance(db, id)).toBe(0);
  expect(await choreBounty(db, choreId)).toBe(0);
  expect(await insideTheApp()).toBe(0);

  expect((await db.query("select distinct status from members")).rows).toEqual([{ status: "pending" }]);
  expect((await db.query("select status from turns order by due_at")).rows.map((r) => r.status)).toEqual([
    "rolled",
    "cancelled",
  ]);
  expect((await getHouse(db, house.houseId))?.settlementDate).toBe("2027-04-30");
  expect((await db.query("select kind from activity where kind = 'settled'")).rows).toHaveLength(1);
});

test("after a settlement, paying the deposit again makes you active", async () => {
  await setup(2);
  await settleHouse(db, payments, { houseId: house.houseId, now: new Date("2026-12-20T15:00:00Z") });
  await applyPaymentEvent(
    db,
    {
      type: "payment_succeeded",
      providerRef: "term2",
      memberId: ids[0],
      amountCents: 2000,
      feeCents: 91,
      purpose: "deposit",
    },
    new Date("2027-01-05T15:00:00Z"),
  );
  expect((await activeMembers(db, house.houseId)).map((m) => m.id)).toEqual([ids[0]]);
});

test("in a house of four the pot closes on the third vote", async () => {
  await setup(4);
  expect(await voteClosePot(db, payments, { memberId: ids[0], now: NOW })).toEqual({
    closed: false,
    votes: 1,
    needed: 3,
  });
  expect(await voteClosePot(db, payments, { memberId: ids[0], now: NOW })).toEqual({
    closed: false,
    votes: 1,
    needed: 3,
  });
  expect(await voteClosePot(db, payments, { memberId: ids[1], now: NOW })).toEqual({
    closed: false,
    votes: 2,
    needed: 3,
  });
  expect(await voteClosePot(db, payments, { memberId: ids[2], now: NOW })).toEqual({
    closed: true,
    votes: 3,
    needed: 3,
  });
  for (const id of ids) expect(await memberBalance(db, id)).toBe(0);
  expect((await db.query("select count(*)::int as n from close_votes")).rows[0].n).toBe(0);
});

test("someone who has not paid in cannot vote to close the pot", async () => {
  house = await makeHouse(3, { active: 2 });
  ids = house.members.map((m) => m.memberId);
  const r = await voteClosePot(db, payments, { memberId: ids[2], now: NOW });
  expect(r).toEqual({ closed: false, votes: 0, needed: 2 });
});

test("a person outside any house has nothing to cash out", async () => {
  const stranger = await makeUser("Zed");
  expect(await memberForUser(db, stranger)).toBeNull();
  const r = await cashOutMember(db, payments, { memberId: "00000000-0000-0000-0000-000000000000", now: NOW });
  expect(r).toEqual({ refundedCents: 0, manualCents: 0, writtenOffCents: 0 });
});
