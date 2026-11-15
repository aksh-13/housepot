import { beforeEach, expect, test } from "vitest";
import { choreBounty, houseBalances, memberBalance, transfer } from "@/domain/ledger";
import { feeCents, formatCents } from "@/money";
import { db, resetDb } from "./helpers";

let houseId: string;
let a: string;
let b: string;
let choreId: string;

beforeEach(async () => {
  await resetDb();
  houseId = (
    await db.query(
      "insert into houses (name, invite_code, deposit_cents, settlement_date) values ('H', 'code', 2000, '2026-12-20') returning id",
    )
  ).rows[0].id;
  const mk = async (phone: string, name: string, pos: number) => {
    const u = (await db.query("insert into users (phone, name) values ($1, $2) returning id", [phone, name]))
      .rows[0].id;
    return (
      await db.query(
        "insert into members (house_id, user_id, status, rotation_position) values ($1, $2, 'active', $3) returning id",
        [houseId, u, pos],
      )
    ).rows[0].id as string;
  };
  a = await mk("+19055550001", "Ana", 0);
  b = await mk("+19055550002", "Ben", 1);
  choreId = (
    await db.query(
      "insert into chores (house_id, name, schedule_kind, weekday, deadline_time, skip_price_cents) values ($1, 'Garbage', 'weekly', 4, '21:00', 500) returning id",
      [houseId],
    )
  ).rows[0].id;
});

test("a skip moves money from the skipper to the chore, and a payout moves it to whoever did it", async () => {
  await transfer(db, { houseId, from: "external", to: { memberId: a }, amountCents: 2000, kind: "deposit" });
  await transfer(db, { houseId, from: "external", to: { memberId: b }, amountCents: 2000, kind: "deposit" });
  await transfer(db, { houseId, from: { memberId: a }, to: { choreId }, amountCents: 500, kind: "skip" });
  expect(await choreBounty(db, choreId)).toBe(500);
  await transfer(db, {
    houseId,
    from: { choreId },
    to: { memberId: b },
    amountCents: 500,
    kind: "bounty_payout",
  });

  expect(await memberBalance(db, a)).toBe(1500);
  expect(await memberBalance(db, b)).toBe(2500);
  expect(await choreBounty(db, choreId)).toBe(0);
});

test("every transfer's two entries add up to zero", async () => {
  await transfer(db, { houseId, from: "external", to: { memberId: a }, amountCents: 2000, kind: "deposit" });
  await transfer(db, { houseId, from: { memberId: a }, to: { choreId }, amountCents: 500, kind: "miss" });
  const { rows } = await db.query(
    "select transfer_id, sum(amount_cents)::int as total, count(*)::int as n from ledger_entries group by transfer_id",
  );
  expect(rows).toHaveLength(2);
  for (const r of rows) {
    expect(r.total).toBe(0);
    expect(r.n).toBe(2);
  }
});

test("a repeated ref is reported as a duplicate and moves no money", async () => {
  const first = await transfer(db, {
    houseId,
    from: "external",
    to: { memberId: a },
    amountCents: 2000,
    kind: "deposit",
    ref: "pay_1",
  });
  const second = await transfer(db, {
    houseId,
    from: "external",
    to: { memberId: a },
    amountCents: 2000,
    kind: "deposit",
    ref: "pay_1",
  });
  expect("transferId" in first).toBe(true);
  expect(second).toEqual({ duplicate: true });
  expect(await memberBalance(db, a)).toBe(2000);
});

test("a duplicate inside a larger transaction does not abort that transaction", async () => {
  await transfer(db, {
    houseId,
    from: "external",
    to: { memberId: a },
    amountCents: 2000,
    kind: "deposit",
    ref: "pay_2",
  });
  await db.tx(async (t) => {
    const dup = await transfer(t, {
      houseId,
      from: "external",
      to: { memberId: a },
      amountCents: 2000,
      kind: "deposit",
      ref: "pay_2",
    });
    expect(dup).toEqual({ duplicate: true });
    await t.query("update members set auto_reload = true where id = $1", [a]);
  });
  const { rows } = await db.query("select auto_reload from members where id = $1", [a]);
  expect(rows[0].auto_reload).toBe(true);
});

test.each([0, -500, 12.5, Number.NaN])("an amount of %s is rejected", async (amountCents) => {
  await expect(
    transfer(db, { houseId, from: "external", to: { memberId: a }, amountCents, kind: "deposit" }),
  ).rejects.toThrow(/positive whole number/);
});

test("a balance can go below zero", async () => {
  await transfer(db, { houseId, from: { memberId: a }, to: { choreId }, amountCents: 500, kind: "miss" });
  expect(await memberBalance(db, a)).toBe(-500);
});

test("houseBalances lists every member in rotation order with their balance", async () => {
  await transfer(db, { houseId, from: "external", to: { memberId: b }, amountCents: 2000, kind: "deposit" });
  expect(await houseBalances(db, houseId)).toEqual([
    { memberId: a, name: "Ana", status: "active", balanceCents: 0 },
    { memberId: b, name: "Ben", status: "active", balanceCents: 2000 },
  ]);
});

test("the card fee on a $20 deposit is 91 cents", () => {
  expect(feeCents(2000)).toBe(91);
});

test("money is shown without cents when it is a whole dollar amount", () => {
  expect(formatCents(2500)).toBe("$25");
  expect(formatCents(1250)).toBe("$12.50");
  expect(formatCents(-500)).toBe("-$5");
  expect(formatCents(0)).toBe("$0");
});
