import { beforeEach, expect, test } from "vitest";
import { ensureTurns } from "@/domain/chores";
import { memberBalance } from "@/domain/ledger";
import { answerSwap, cancelSwap, lapseSwaps, openSwaps, requestSwap } from "@/domain/swaps";
import { missTurn } from "@/domain/turns";
import { addChore, db, makeHouse, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z"); // Wed noon Toronto; Thursday chores are due 21:00 tomorrow
const LATE = new Date("2026-11-13T02:00:01Z"); // one second past Thursday's deadline
const NEXT_WEEK = new Date("2026-11-18T17:00:00Z");

let house: TestHouse;
let ana: string;
let ben: string;
let cy: string;

beforeEach(async () => {
  await resetDb();
  house = await makeHouse(3, { moneyMode: "etransfer" });
  [ana, ben, cy] = house.members.map((m) => m.memberId);
});

async function chore(name: string, firstMemberId: string) {
  const r = await addChore(db, {
    houseId: house.houseId,
    memberId: ana,
    name,
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    firstMemberId,
    now: NOW,
  });
  if (!r.ok) throw new Error(r.error);
  await ensureTurns(db, house.houseId, NOW);
  return (
    await db.query<{ id: string }>("select id from turns where chore_id = $1 and status = 'assigned'", [
      r.choreId,
    ])
  ).rows[0].id;
}

const owner = async (turnId: string) =>
  (await db.query("select assignee_member_id from turns where id = $1", [turnId])).rows[0].assignee_member_id;

test("a turn only moves when the other person accepts", async () => {
  const garbage = await chore("Garbage", ana);
  const asked = await requestSwap(db, { turnId: garbage, memberId: ana, toMemberId: ben, now: NOW });
  if (!asked.ok) throw new Error(asked.error);
  expect(await owner(garbage)).toBe(ana);
  expect(await openSwaps(db, house.houseId)).toMatchObject([
    { choreName: "Garbage", fromName: "Ana", toName: "Ben" },
  ]);

  expect(await answerSwap(db, { requestId: asked.requestId, memberId: cy, accept: true, now: NOW })).toEqual({
    ok: false,
    error: "That request is for someone else.",
  });
  expect(await answerSwap(db, { requestId: asked.requestId, memberId: ben, accept: true, now: NOW })).toEqual(
    {
      ok: true,
      accepted: true,
    },
  );
  expect(await owner(garbage)).toBe(ben);
  expect(await openSwaps(db, house.houseId)).toEqual([]);
});

test("once accepted it is theirs: if it expires, it costs them", async () => {
  const garbage = await chore("Garbage", ana);
  const asked = await requestSwap(db, { turnId: garbage, memberId: ana, toMemberId: ben, now: NOW });
  if (!asked.ok) throw new Error(asked.error);
  await answerSwap(db, { requestId: asked.requestId, memberId: ben, accept: true, now: NOW });
  await missTurn(db, { turnId: garbage, now: LATE });
  expect(await memberBalance(db, ben)).toBe(-500);
  expect(await memberBalance(db, ana)).toBe(0);
});

test("an exchange moves both turns at once", async () => {
  const garbage = await chore("Garbage", ana);
  const dishes = await chore("Dishes", ben);
  const asked = await requestSwap(db, {
    turnId: garbage,
    memberId: ana,
    toMemberId: ben,
    giveBackTurnId: dishes,
    now: NOW,
  });
  if (!asked.ok) throw new Error(asked.error);
  await answerSwap(db, { requestId: asked.requestId, memberId: ben, accept: true, now: NOW });
  expect([await owner(garbage), await owner(dishes)]).toEqual([ben, ana]);
});

test("declining or cancelling leaves the turn where it was", async () => {
  const garbage = await chore("Garbage", ana);
  const first = await requestSwap(db, { turnId: garbage, memberId: ana, toMemberId: ben, now: NOW });
  if (!first.ok) throw new Error(first.error);
  expect(
    await answerSwap(db, { requestId: first.requestId, memberId: ben, accept: false, now: NOW }),
  ).toEqual({
    ok: true,
    accepted: false,
  });
  const second = await requestSwap(db, { turnId: garbage, memberId: ana, toMemberId: cy, now: NOW });
  if (!second.ok) throw new Error(second.error);
  expect(await cancelSwap(db, { requestId: second.requestId, memberId: ben, now: NOW })).toEqual({
    ok: false,
    error: "Only the person who asked can cancel it.",
  });
  expect(await cancelSwap(db, { requestId: second.requestId, memberId: ana, now: NOW })).toEqual({
    ok: true,
  });
  expect(await owner(garbage)).toBe(ana);
});

test("you can only ask about your own waiting turn, one request at a time", async () => {
  const garbage = await chore("Garbage", ana);
  expect(await requestSwap(db, { turnId: garbage, memberId: ben, toMemberId: cy, now: NOW })).toEqual({
    ok: false,
    error: "It is not your turn.",
  });
  expect(await requestSwap(db, { turnId: garbage, memberId: ana, toMemberId: ana, now: NOW })).toEqual({
    ok: false,
    error: "Pick someone else.",
  });
  await requestSwap(db, { turnId: garbage, memberId: ana, toMemberId: ben, now: NOW });
  expect(await requestSwap(db, { turnId: garbage, memberId: ana, toMemberId: cy, now: NOW })).toEqual({
    ok: false,
    error: "You have already asked someone about this turn.",
  });
});

test("a request is no way past a deadline: it lapses, and cannot be accepted late", async () => {
  const garbage = await chore("Garbage", ana);
  const asked = await requestSwap(db, { turnId: garbage, memberId: ana, toMemberId: ben, now: NOW });
  if (!asked.ok) throw new Error(asked.error);
  expect(
    await answerSwap(db, { requestId: asked.requestId, memberId: ben, accept: true, now: LATE }),
  ).toEqual({
    ok: false,
    error: "Too late to swap: that turn's deadline has passed.",
  });
  expect(await owner(garbage)).toBe(ana);

  const again = await chore("Dishes", ana);
  await requestSwap(db, { turnId: again, memberId: ana, toMemberId: ben, now: NOW });
  expect(await lapseSwaps(db, house.houseId, LATE)).toBe(1);
  expect(await openSwaps(db, house.houseId)).toEqual([]);
});

test("a swap does not reshuffle the rotation: next week goes to whoever was next anyway", async () => {
  const garbage = await chore("Garbage", ana);
  const asked = await requestSwap(db, { turnId: garbage, memberId: ana, toMemberId: cy, now: NOW });
  if (!asked.ok) throw new Error(asked.error);
  await answerSwap(db, { requestId: asked.requestId, memberId: cy, accept: true, now: NOW });
  await db.query("update turns set status = 'done' where id = $1", [garbage]);
  await ensureTurns(db, house.houseId, NEXT_WEEK);
  const next = await db.query("select assignee_member_id from turns where status = 'assigned'");
  expect(next.rows[0].assignee_member_id).toBe(ben);
});
