import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import { createChore, ensureTurns } from "@/domain/chores";
import { getHouse, setAutoReload, setPaused } from "@/domain/houses";
import { choreBounty, memberBalance, transfer } from "@/domain/ledger";
import { savePhoto } from "@/domain/photos";
import { runTick } from "@/domain/tick";
import { type FakePayments, fakePayments } from "@/providers/payments";
import { fakeSms } from "@/providers/sms";
import { diskStorage } from "@/providers/storage";
import { db, makeHouse, markDone, resetDb, type TestHouse } from "./helpers";

const BASE = "https://housepot.test";
const WED_NOON = new Date("2026-11-11T17:00:00Z"); // garbage is due Thu 21:00 Toronto = Fri 02:00Z
const THU_7AM = new Date("2026-11-12T12:00:00Z");
const THU_8AM = new Date("2026-11-12T13:00:00Z");
const THU_7PM = new Date("2026-11-13T00:00:00Z");
const LATE = new Date("2026-11-13T02:00:01Z");
const MIN = 60_000;
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);

let house: TestHouse;
let ids: string[];
let choreId: string;
let payments: FakePayments;
const sms = fakeSms(db);
const tick = (now: Date) => runTick(db, { sms, payments }, now, BASE);

beforeEach(async () => {
  await resetDb();
  payments = fakePayments();
  house = await makeHouse(3);
  ids = house.members.map((m) => m.memberId);
  const chore = await createChore(db, {
    houseId: house.houseId,
    memberId: ids[0],
    name: "Garbage",
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    now: WED_NOON,
  });
  if (!chore.ok) throw new Error(chore.error);
  choreId = chore.choreId;
});

const texts = async () => (await db.query("select to_phone, body from sms_outbox order by id")).rows;
const drain = (memberId: string, amountCents: number) =>
  transfer(db, {
    houseId: house.houseId,
    from: { memberId },
    to: "external",
    amountCents,
    kind: "cashout_manual",
  });

test("the first tick hands out the first turn", async () => {
  expect(await tick(WED_NOON)).toMatchObject({ turnsCreated: 1, misses: 0, reminders: 0 });
  const { rows } = await db.query("select assignee_member_id, status from turns");
  expect(rows).toEqual([{ assignee_member_id: ids[0], status: "assigned" }]);
  expect(await texts()).toEqual([]);
});

test("a turn past its deadline is charged once, everyone is told once, and the next turn is handed out", async () => {
  await tick(WED_NOON);
  await db.query("update turns set reminded_morning_at = now(), reminded_final_at = now()");
  expect(await tick(LATE)).toMatchObject({ misses: 1, turnsCreated: 1 });

  expect(await memberBalance(db, ids[0])).toBe(1500);
  expect(await choreBounty(db, choreId)).toBe(500);
  const sent = await texts();
  expect(sent).toHaveLength(3);
  expect(sent[0]).toEqual({
    to_phone: house.members[0].phone,
    body: expect.stringMatching(/missed Garbage.*\$5.*\$15.*https:\/\/housepot\.test\/house/s),
  });
  expect(
    sent
      .slice(1)
      .map((t) => t.to_phone)
      .sort(),
  ).toEqual([house.members[1].phone, house.members[2].phone].sort());
  for (const t of sent.slice(1)) expect(t.body).toMatch(/Garbage is open.*\$5/s);

  expect(await tick(plus(LATE, 5 * MIN))).toMatchObject({ misses: 0, turnsCreated: 0 });
  expect(await tick(plus(LATE, 10 * MIN))).toMatchObject({ misses: 0, turnsCreated: 0 });
  expect(await memberBalance(db, ids[0])).toBe(1500);
  expect(await texts()).toHaveLength(3);
});

test("two ticks at the same moment charge a miss once", async () => {
  await tick(WED_NOON);
  await db.query("update turns set reminded_morning_at = now(), reminded_final_at = now()");
  const results = await Promise.all([tick(LATE), tick(LATE)]);
  expect(results.reduce((n, r) => n + r.misses, 0)).toBe(1);
  expect(results.filter((r) => r.skippedLocked)).toHaveLength(1);
  expect(await memberBalance(db, ids[0])).toBe(1500);
  expect(await texts()).toHaveLength(3);
});

test("the morning reminder goes out once, at 8am or later on the day", async () => {
  await tick(WED_NOON);
  expect((await tick(THU_7AM)).reminders).toBe(0);
  expect((await tick(THU_8AM)).reminders).toBe(1);
  expect((await tick(plus(THU_8AM, 5 * MIN))).reminders).toBe(0);
  expect(await texts()).toEqual([
    {
      to_phone: house.members[0].phone,
      body: expect.stringMatching(/Garbage is yours today, by 9:00 PM.*https:\/\/housepot\.test\/house/s),
    },
  ]);
});

test("the final reminder goes out once, two hours before the deadline", async () => {
  await tick(WED_NOON);
  await tick(THU_8AM);
  expect((await tick(plus(THU_7PM, -MIN))).reminders).toBe(0);
  expect((await tick(THU_7PM)).reminders).toBe(1);
  expect((await tick(plus(THU_7PM, 5 * MIN))).reminders).toBe(0);
  const sent = await texts();
  expect(sent).toHaveLength(2);
  expect(sent[1].body).toMatch(/2 hours left.*Garbage/s);
});

test("when both reminders are due at once, only the final one is sent", async () => {
  await tick(WED_NOON);
  expect((await tick(THU_7PM)).reminders).toBe(1);
  expect((await tick(plus(THU_7PM, 5 * MIN))).reminders).toBe(0);
  expect((await texts())[0].body).toMatch(/2 hours left/);
});

test("no reminders for a turn that is already done", async () => {
  await tick(WED_NOON);
  const turn = (await db.query("select id from turns")).rows[0];
  const storage = diskStorage(mkdtempSync(path.join(tmpdir(), "housepot-test-")));
  const p = await savePhoto(db, storage, {
    houseId: house.houseId,
    memberId: ids[0],
    bytes: Buffer.from([1]),
    contentType: "image/jpeg",
    now: WED_NOON,
  });
  if (!p.ok) throw new Error(p.error);
  await markDone(db, { turnId: turn.id, memberId: ids[0], photoId: p.photoId, now: WED_NOON });
  expect((await tick(THU_8AM)).reminders).toBe(0);
  expect((await tick(THU_7PM)).reminders).toBe(0);
  expect((await tick(LATE)).misses).toBe(0);
});

test("a paused house is not charged, reminded, or given turns", async () => {
  await tick(WED_NOON);
  await setPaused(db, { houseId: house.houseId, memberId: ids[0], paused: true, now: WED_NOON });
  expect(await tick(LATE)).toMatchObject({ misses: 0, reminders: 0, turnsCreated: 0 });
  expect(await memberBalance(db, ids[0])).toBe(2000);
  expect(await texts()).toEqual([]);
});

test("auto-reload tops a member at or below zero back up to the deposit, once", async () => {
  await db.query("update members set customer_ref = 'cus_1' where id = $1", [ids[1]]);
  await setAutoReload(db, ids[1], true);
  await drain(ids[1], 2500); // -500

  expect((await tick(WED_NOON)).autoReloads).toBe(1);
  expect(await memberBalance(db, ids[1])).toBe(2000);
  expect(payments.charges).toMatchObject([
    { memberId: ids[1], customerRef: "cus_1", amountCents: 2500, feeCents: 106 },
  ]);

  expect((await tick(plus(WED_NOON, 5 * MIN))).autoReloads).toBe(0);
  expect(payments.charges).toHaveLength(1);
});

test("auto-reload leaves alone members who are above zero, have no saved card, or have it switched off", async () => {
  await db.query("update members set customer_ref = 'cus_0' where id = $1", [ids[0]]);
  await setAutoReload(db, ids[0], true);
  await drain(ids[0], 1500); // 500, above zero
  await setAutoReload(db, ids[1], true); // no saved card
  await drain(ids[1], 2000);
  await db.query("update members set customer_ref = 'cus_2' where id = $1", [ids[2]]); // switched off
  await drain(ids[2], 2000);

  expect((await tick(WED_NOON)).autoReloads).toBe(0);
  expect(payments.charges).toEqual([]);
});

test("a declined auto-reload switches itself off and tells the member once", async () => {
  await db.query("update members set customer_ref = 'fail_1' where id = $1", [ids[1]]);
  await setAutoReload(db, ids[1], true);
  await drain(ids[1], 2000);

  expect((await tick(WED_NOON)).autoReloads).toBe(0);
  expect(await memberBalance(db, ids[1])).toBe(0);
  expect(
    (await db.query("select auto_reload from members where id = $1", [ids[1]])).rows[0].auto_reload,
  ).toBe(false);
  expect(await texts()).toEqual([
    {
      to_phone: house.members[1].phone,
      body: expect.stringMatching(/card was declined.*auto-reload is off/is),
    },
  ]);
  await tick(plus(WED_NOON, 5 * MIN));
  expect(await texts()).toHaveLength(1);
});

test("the top-up request goes out at the start of the month, once, to members below the deposit", async () => {
  // No chores and no settlement in sight, so the only thing that can happen is the request.
  await db.query("update chores set archived = true");
  await db.query("update houses set settlement_date = '2030-01-01'");
  await drain(ids[0], 500); // 1500
  expect((await tick(WED_NOON)).topupRequests).toBe(0); // mid-month: nothing

  const DEC_1 = new Date("2026-12-01T15:00:00Z");
  expect((await tick(DEC_1)).topupRequests).toBe(1);
  expect((await tick(plus(DEC_1, 5 * MIN))).topupRequests).toBe(0);
  const requests = (await texts()).filter((t) => /top up/i.test(t.body));
  expect(requests).toEqual([
    {
      to_phone: house.members[0].phone,
      body: expect.stringMatching(/\$15.*top up \$5.*\$20.*https:\/\/housepot\.test\/house/is),
    },
  ]);

  expect((await tick(new Date("2027-01-01T15:00:00Z"))).topupRequests).toBe(1);
});

test("a house is settled on its settlement date, even while paused", async () => {
  await tick(WED_NOON);
  await setPaused(db, { houseId: house.houseId, memberId: ids[0], paused: true, now: WED_NOON });
  expect((await tick(new Date("2026-12-19T15:00:00Z"))).settled).toBe(0);
  expect((await tick(new Date("2026-12-20T15:00:00Z"))).settled).toBe(1);
  for (const id of ids) expect(await memberBalance(db, id)).toBe(0);
  expect((await getHouse(db, house.houseId))?.settlementDate).toBe("2027-04-30");
  expect((await tick(new Date("2026-12-20T15:05:00Z"))).settled).toBe(0);
});

test("a text that fails to send does not stop the tick", async () => {
  await tick(WED_NOON);
  const broken = { send: async () => Promise.reject(new Error("carrier down")) };
  const r = await runTick(db, { sms: broken, payments }, LATE, BASE);
  expect(r).toMatchObject({ misses: 1, turnsCreated: 1 });
  expect(await memberBalance(db, ids[0])).toBe(1500);
});

test("ensureTurns is still called for houses with nothing else to do", async () => {
  await ensureTurns(db, house.houseId, WED_NOON);
  expect((await tick(WED_NOON)).turnsCreated).toBe(0);
});
