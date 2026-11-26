import { beforeEach, expect, test } from "vitest";
import { createChore, ensureTurns, listChores, updateChore } from "@/domain/chores";
import { setPaused } from "@/domain/houses";
import { db, makeHouse, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z"); // Wed 12:00 Toronto
const WEEK = 7 * 24 * 3600_000;
const THURSDAY = { kind: "weekly", weekday: 4 } as const;

beforeEach(resetDb);

async function garbage(house: TestHouse) {
  const r = await createChore(db, {
    houseId: house.houseId,
    memberId: house.members[0].memberId,
    name: "Garbage",
    schedule: THURSDAY,
    deadlineTime: "21:00",
    now: NOW,
  });
  if (!r.ok) throw new Error(r.error);
  return r.choreId;
}

const turns = async () =>
  (await db.query("select assignee_member_id, due_at, status from turns order by due_at, created_at")).rows;

/** Stands in for the turn being finished, so the next one can be created. */
const finishAssigned = () => db.query("update turns set status = 'done' where status = 'assigned'");

test("a chore defaults to a $5 skip price and appears in the list", async () => {
  const house = await makeHouse(2);
  const choreId = await garbage(house);
  expect(await listChores(db, house.houseId)).toEqual([
    {
      id: choreId,
      name: "Garbage",
      schedule: { kind: "weekly", weekday: 4 },
      deadlineTime: "21:00",
      skipPriceCents: 500,
      archived: false,
      teamDuty: false,
    },
  ]);
});

test.each([
  [{ name: " " }, /name/i],
  [{ deadlineTime: "25:00" }, /time/i],
  [{ deadlineTime: "9pm" }, /time/i],
  [{ skipPriceCents: 50 }, /skip price/i],
  [{ skipPriceCents: 250.5 }, /skip price/i],
  [{ schedule: { kind: "weekly", weekday: 8 } }, /day/i],
  [{ schedule: { kind: "every_n_days", n: 0, anchorDate: "2026-11-10" } }, /days/i],
  [{ schedule: { kind: "every_n_days", n: 3, anchorDate: "not-a-date" } }, /date/i],
])("a chore with %j is refused", async (bad, message) => {
  const house = await makeHouse(1);
  const r = await createChore(db, {
    houseId: house.houseId,
    memberId: house.members[0].memberId,
    name: "Garbage",
    schedule: THURSDAY,
    deadlineTime: "21:00",
    now: NOW,
    ...(bad as object),
  } as any);
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(message);
});

test("someone from another house cannot add a chore here", async () => {
  const house = await makeHouse(1);
  const other = await makeHouse(1);
  const r = await createChore(db, {
    houseId: house.houseId,
    memberId: other.members[0].memberId,
    name: "Garbage",
    schedule: THURSDAY,
    deadlineTime: "21:00",
    now: NOW,
  });
  expect(r.ok).toBe(false);
});

test("the first turn goes to the first housemate, due at the next deadline", async () => {
  const house = await makeHouse(3);
  await garbage(house);
  expect(await ensureTurns(db, house.houseId, NOW)).toBe(1);
  expect(await turns()).toEqual([
    {
      assignee_member_id: house.members[0].memberId,
      due_at: new Date("2026-11-13T02:00:00Z"),
      status: "assigned",
    },
  ]);
});

test("calling ensureTurns again while a turn is waiting creates nothing", async () => {
  const house = await makeHouse(3);
  await garbage(house);
  await ensureTurns(db, house.houseId, NOW);
  expect(await ensureTurns(db, house.houseId, NOW)).toBe(0);
  expect(await turns()).toHaveLength(1);
});

test("two ensureTurns at the same moment create one turn", async () => {
  const house = await makeHouse(3);
  await garbage(house);
  await Promise.all([ensureTurns(db, house.houseId, NOW), ensureTurns(db, house.houseId, NOW)]);
  expect(await turns()).toHaveLength(1);
});

test("turns go round the house A, B, C, A, one week apart", async () => {
  const house = await makeHouse(3);
  await garbage(house);
  const [a, b, c] = house.members.map((m) => m.memberId);
  for (let i = 0; i < 4; i++) {
    await ensureTurns(db, house.houseId, new Date(NOW.getTime() + i * WEEK));
    await finishAssigned();
  }
  const all = await turns();
  expect(all.map((t) => t.assignee_member_id)).toEqual([a, b, c, a]);
  expect(all.map((t) => t.due_at.toISOString())).toEqual([
    "2026-11-13T02:00:00.000Z",
    "2026-11-20T02:00:00.000Z",
    "2026-11-27T02:00:00.000Z",
    "2026-12-04T02:00:00.000Z",
  ]);
});

test("the next turn is due after the previous one even when created early", async () => {
  const house = await makeHouse(2);
  await garbage(house);
  await ensureTurns(db, house.houseId, NOW);
  await finishAssigned(); // done on Wednesday, a day before the deadline
  await ensureTurns(db, house.houseId, NOW);
  expect((await turns()).map((t) => t.due_at.toISOString())).toEqual([
    "2026-11-13T02:00:00.000Z",
    "2026-11-20T02:00:00.000Z",
  ]);
});

test("housemates who have not paid or who have left are never given a turn", async () => {
  const house = await makeHouse(4, { active: 3 }); // the fourth is pending
  await garbage(house);
  const [a, b, c] = house.members.map((m) => m.memberId);
  await db.query("update members set status = 'left' where id = $1", [b]);
  for (let i = 0; i < 4; i++) {
    await ensureTurns(db, house.houseId, new Date(NOW.getTime() + i * WEEK));
    await finishAssigned();
  }
  expect((await turns()).map((t) => t.assignee_member_id)).toEqual([a, c, a, c]);
});

test("a house where nobody has paid gets no turns", async () => {
  const house = await makeHouse(2, { active: 0 });
  // Unpaid housemates cannot add chores, so this one is put in place directly.
  await db.query(
    "insert into chores (house_id, name, schedule_kind, weekday, deadline_time, skip_price_cents) values ($1, 'Garbage', 'weekly', 4, '21:00', 500)",
    [house.houseId],
  );
  expect(await ensureTurns(db, house.houseId, NOW)).toBe(0);
  expect(await turns()).toEqual([]);
});

test("a paused house gets no turns, and the same person is up again after it resumes", async () => {
  const house = await makeHouse(2);
  await garbage(house);
  const a = house.members[0].memberId;
  await ensureTurns(db, house.houseId, NOW);
  await setPaused(db, { houseId: house.houseId, memberId: a, paused: true, now: NOW });
  expect(await ensureTurns(db, house.houseId, NOW)).toBe(0);

  const later = new Date(NOW.getTime() + 3 * WEEK);
  await setPaused(db, { houseId: house.houseId, memberId: a, paused: false, now: later });
  await ensureTurns(db, house.houseId, later);
  const waiting = (await turns()).filter((t) => t.status === "assigned");
  expect(waiting).toEqual([
    { assignee_member_id: a, due_at: new Date("2026-12-04T02:00:00Z"), status: "assigned" },
  ]);
});

test("an archived chore gets no turns and its waiting turn is cancelled", async () => {
  const house = await makeHouse(2);
  const choreId = await garbage(house);
  await ensureTurns(db, house.houseId, NOW);
  await updateChore(db, { choreId, memberId: house.members[0].memberId, archived: true, now: NOW });
  expect((await turns()).map((t) => t.status)).toEqual(["cancelled"]);
  expect(await ensureTurns(db, house.houseId, NOW)).toBe(0);
});

test("changing the day cancels the waiting turn and the same person gets the new one", async () => {
  const house = await makeHouse(2);
  const choreId = await garbage(house);
  const a = house.members[0].memberId;
  await ensureTurns(db, house.houseId, NOW);
  await updateChore(db, { choreId, memberId: a, schedule: { kind: "weekly", weekday: 5 }, now: NOW });
  await ensureTurns(db, house.houseId, NOW);
  const all = await turns();
  expect(all.map((t) => t.status).sort()).toEqual(["assigned", "cancelled"]);
  expect(all.find((t) => t.status === "assigned")).toEqual({
    assignee_member_id: a,
    due_at: new Date("2026-11-14T02:00:00Z"), // Friday 21:00
    status: "assigned",
  });
});

test("changing only the price keeps the waiting turn", async () => {
  const house = await makeHouse(2);
  const choreId = await garbage(house);
  await ensureTurns(db, house.houseId, NOW);
  await updateChore(db, { choreId, memberId: house.members[0].memberId, skipPriceCents: 800, now: NOW });
  expect((await turns()).map((t) => t.status)).toEqual(["assigned"]);
  expect((await listChores(db, house.houseId))[0].skipPriceCents).toBe(800);
});

test("adding and editing a chore is written to the activity feed", async () => {
  const house = await makeHouse(1);
  const choreId = await garbage(house);
  await updateChore(db, { choreId, memberId: house.members[0].memberId, name: "Bins", now: NOW });
  const kinds = (await db.query("select kind from activity order by created_at, id")).rows.map((r) => r.kind);
  expect(kinds).toEqual(expect.arrayContaining(["chore_added", "chore_updated"]));
});

const nowAssigned = async () =>
  (await db.query("select assignee_member_id from turns where status = 'assigned'")).rows[0]
    ?.assignee_member_id;

async function chore(house: TestHouse, by: number, firstMemberId?: string) {
  return createChore(db, {
    houseId: house.houseId,
    memberId: house.members[by].memberId,
    name: "Dishes",
    schedule: THURSDAY,
    deadlineTime: "21:00",
    firstMemberId,
    now: NOW,
  });
}

test("a chore can be given to any housemate first, and then goes round the house from them", async () => {
  const house = await makeHouse(3);
  const [ana, ben, cy] = house.members.map((m) => m.memberId);
  expect((await chore(house, 0, cy)).ok).toBe(true);

  await ensureTurns(db, house.houseId, NOW);
  expect(await nowAssigned()).toBe(cy);
  await finishAssigned();
  await ensureTurns(db, house.houseId, NOW);
  expect(await nowAssigned()).toBe(ana);
  await finishAssigned();
  await ensureTurns(db, house.houseId, NOW);
  expect(await nowAssigned()).toBe(ben);
});

test("with nobody picked, the first turn goes to whoever added the chore", async () => {
  const house = await makeHouse(3);
  expect((await chore(house, 1)).ok).toBe(true);
  await ensureTurns(db, house.houseId, NOW);
  expect(await nowAssigned()).toBe(house.members[1].memberId);
});

test("the person picked to go first must be an active housemate of this house", async () => {
  const house = await makeHouse(2);
  const other = await makeHouse(1);
  const refused = { ok: false, error: "Pick a housemate to go first." };
  expect(await chore(house, 0, other.members[0].memberId)).toEqual(refused);
  await db.query("update members set status = 'left' where id = $1", [house.members[1].memberId]);
  expect(await chore(house, 0, house.members[1].memberId)).toEqual(refused);
  expect((await db.query("select count(*)::int as n from chores")).rows[0].n).toBe(0);
});

test("if the person picked leaves before the first turn, it goes to the first housemate in the rotation", async () => {
  const house = await makeHouse(3);
  const [ana, , cy] = house.members.map((m) => m.memberId);
  await chore(house, 0, cy);
  await db.query("update members set status = 'left' where id = $1", [cy]);
  await ensureTurns(db, house.houseId, NOW);
  expect(await nowAssigned()).toBe(ana);
});

test("the activity feed says who a new chore starts with when it is someone else", async () => {
  const house = await makeHouse(2);
  await chore(house, 0, house.members[1].memberId);
  await chore(house, 0);
  const { rows } = await db.query("select data from activity where kind = 'chore_added'");
  // Both were added at the same moment, so the feed's order between them is not fixed.
  const names = rows.map((r) => r.data.firstName ?? null).sort();
  expect(rows.every((r) => r.data.name === "Dishes")).toBe(true);
  expect(names).toEqual(["Ben", null].sort());
});
