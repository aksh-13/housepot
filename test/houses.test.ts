import { afterEach, beforeEach, expect, test } from "vitest";
import {
  activeMembers,
  createHouse,
  joinHouse,
  memberForUser,
  setAutoReload,
  setPaused,
} from "@/domain/houses";
import { nextTermEnd } from "@/time";
import { db, makeUser, resetDb } from "./helpers";

const NOW = new Date("2026-11-14T15:00:00Z");

beforeEach(resetDb);
afterEach(() => {
  delete process.env.CARD_HOUSES;
});

test("the creator and each joiner take the next place in the rotation, all pending until they pay", async () => {
  const [u1, u2, u3] = [await makeUser("Ana"), await makeUser("Ben"), await makeUser("Cy")];
  const house = await createHouse(db, { userId: u1, houseName: "12 Elm", now: NOW });
  if (!house.ok) throw new Error(house.error);
  const j2 = await joinHouse(db, { userId: u2, inviteCode: house.inviteCode, now: NOW });
  const j3 = await joinHouse(db, { userId: u3, inviteCode: house.inviteCode, now: NOW });
  expect(j2.ok && j3.ok).toBe(true);

  const { rows } = await db.query(
    "select rotation_position, status from members where house_id = $1 order by rotation_position",
    [house.houseId],
  );
  expect(rows).toEqual([
    { rotation_position: 0, status: "pending" },
    { rotation_position: 1, status: "pending" },
    { rotation_position: 2, status: "pending" },
  ]);
  expect(await activeMembers(db, house.houseId)).toEqual([]);
});

test("a new house defaults to a $20 deposit, Toronto time, and settles at the end of term", async () => {
  const house = await createHouse(db, { userId: await makeUser("Ana"), houseName: "12 Elm", now: NOW });
  if (!house.ok) throw new Error(house.error);
  const { rows } = await db.query(
    "select deposit_cents, tz, settlement_date, paused from houses where id = $1",
    [house.houseId],
  );
  expect(rows[0]).toEqual({
    deposit_cents: 2000,
    tz: "America/Toronto",
    settlement_date: "2026-12-20",
    paused: false,
  });
});

test("a house name is required and the deposit must be between $5 and $200", async () => {
  const userId = await makeUser("Ana");
  expect((await createHouse(db, { userId, houseName: "  ", now: NOW })).ok).toBe(false);
  expect((await createHouse(db, { userId, houseName: "H", depositCents: 400, now: NOW })).ok).toBe(false);
  expect((await createHouse(db, { userId, houseName: "H", depositCents: 20001, now: NOW })).ok).toBe(false);
  expect((await createHouse(db, { userId, houseName: "H", depositCents: 12.5, now: NOW })).ok).toBe(false);
});

test("joining with a code that does not exist fails", async () => {
  const r = await joinHouse(db, { userId: await makeUser("Ben"), inviteCode: "nope", now: NOW });
  expect(r).toEqual({ ok: false, error: "That invite link does not match any house." });
});

test("someone already in a house cannot join or create another", async () => {
  const u1 = await makeUser("Ana");
  const u2 = await makeUser("Ben");
  const h1 = await createHouse(db, { userId: u1, houseName: "One", now: NOW });
  const h2 = await createHouse(db, { userId: u2, houseName: "Two", now: NOW });
  if (!h1.ok || !h2.ok) throw new Error("setup");
  expect((await joinHouse(db, { userId: u1, inviteCode: h2.inviteCode, now: NOW })).ok).toBe(false);
  expect((await createHouse(db, { userId: u1, houseName: "Three", now: NOW })).ok).toBe(false);
});

test("joining the house you are already in gives back the same membership", async () => {
  const u1 = await makeUser("Ana");
  const h = await createHouse(db, { userId: u1, houseName: "One", now: NOW });
  if (!h.ok) throw new Error("setup");
  expect(await joinHouse(db, { userId: u1, inviteCode: h.inviteCode, now: NOW })).toEqual({
    ok: true,
    memberId: h.memberId,
  });
});

test("memberForUser returns the membership with the person's name", async () => {
  const u1 = await makeUser("Ana");
  const h = await createHouse(db, { userId: u1, houseName: "One", now: NOW });
  if (!h.ok) throw new Error("setup");
  expect(await memberForUser(db, u1)).toMatchObject({
    id: h.memberId,
    houseId: h.houseId,
    status: "pending",
    rotationPosition: 0,
    autoReload: false,
    name: "Ana",
  });
  expect(await memberForUser(db, await makeUser("Nobody"))).toBeNull();
});

test("pausing cancels turns that are waiting, and is recorded in the activity feed", async () => {
  const u1 = await makeUser("Ana");
  const h = await createHouse(db, { userId: u1, houseName: "One", now: NOW });
  if (!h.ok) throw new Error("setup");
  await db.query("update members set status = 'active' where id = $1", [h.memberId]); // paid in
  const chore = await db.query(
    "insert into chores (house_id, name, schedule_kind, weekday, deadline_time, skip_price_cents) values ($1, 'Garbage', 'weekly', 4, '21:00', 500) returning id",
    [h.houseId],
  );
  await db.query(
    "insert into turns (chore_id, house_id, assignee_member_id, due_at) values ($1, $2, $3, $4)",
    [chore.rows[0].id, h.houseId, h.memberId, new Date("2026-11-19T02:00:00Z")],
  );
  await setPaused(db, { houseId: h.houseId, memberId: h.memberId, paused: true, now: NOW });

  expect((await db.query("select paused from houses")).rows[0].paused).toBe(true);
  expect((await db.query("select status from turns")).rows[0].status).toBe("cancelled");
  expect((await db.query("select kind from activity")).rows.map((r) => r.kind)).toContain("paused");
});

test("auto-reload can be switched on and off", async () => {
  const u1 = await makeUser("Ana");
  const h = await createHouse(db, { userId: u1, houseName: "One", now: NOW });
  if (!h.ok) throw new Error("setup");
  await setAutoReload(db, h.memberId, true);
  expect((await memberForUser(db, u1))?.autoReload).toBe(true);
  await setAutoReload(db, h.memberId, false);
  expect((await memberForUser(db, u1))?.autoReload).toBe(false);
});

test.each([
  ["2026-11-14T15:00:00Z", "2026-12-20"],
  ["2026-12-20T15:00:00Z", "2027-04-30"],
  ["2027-04-29T15:00:00Z", "2027-04-30"],
  ["2027-05-01T15:00:00Z", "2027-08-31"],
  // 03:00 UTC on Dec 20 is still Dec 19 in Toronto.
  ["2026-12-20T03:00:00Z", "2026-12-20"],
])("the term end after %s is %s", (now, expected) => {
  expect(nextTermEnd(new Date(now), "America/Toronto")).toBe(expected);
});

test("a card house cannot be created when card houses are off", async () => {
  process.env.CARD_HOUSES = "off";
  const created = await createHouse(db, {
    userId: await makeUser("Ana"),
    houseName: "12 Elm",
    moneyMode: "card",
    now: NOW,
  });
  expect(created).toEqual({ ok: false, error: "Card houses are switched off." });
  expect((await db.query("select count(*)::int as n from houses")).rows[0].n).toBe(0);
});

test("an e-Transfer house can still be created when card houses are off", async () => {
  process.env.CARD_HOUSES = "off";
  const created = await createHouse(db, {
    userId: await makeUser("Ana"),
    houseName: "12 Elm",
    moneyMode: "etransfer",
    now: NOW,
  });
  expect(created.ok).toBe(true);
});

test("joining an e-Transfer house saves the sign-in email as the e-Transfer email", async () => {
  const ana = await makeUser("Ana", { email: "ana@example.com" });
  const ben = await makeUser("Ben", { email: "ben@example.com" });
  const cy = await makeUser("Cy");
  const house = await createHouse(db, { userId: ana, houseName: "12 Elm", moneyMode: "etransfer", now: NOW });
  if (!house.ok) throw new Error(house.error);
  await joinHouse(db, { userId: ben, inviteCode: house.inviteCode, now: NOW });
  await joinHouse(db, { userId: cy, inviteCode: house.inviteCode, now: NOW });
  expect((await memberForUser(db, ana))?.etransferEmail).toBe("ana@example.com");
  expect((await memberForUser(db, ben))?.etransferEmail).toBe("ben@example.com");
  expect((await memberForUser(db, cy))?.etransferEmail).toBeNull();
});

test("a member's contact is their email when they have one, otherwise their phone", async () => {
  const ana = await makeUser("Ana", { email: "ana@example.com" });
  const ben = await makeUser("Ben");
  const house = await createHouse(db, { userId: ana, houseName: "12 Elm", moneyMode: "etransfer", now: NOW });
  if (!house.ok) throw new Error(house.error);
  await joinHouse(db, { userId: ben, inviteCode: house.inviteCode, now: NOW });
  expect((await memberForUser(db, ana))?.contact).toBe("ana@example.com");
  const benPhone = (await db.query("select phone from users where id = $1", [ben])).rows[0].phone;
  expect((await memberForUser(db, ben))?.contact).toBe(benPhone);
});
