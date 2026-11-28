import { beforeEach, expect, test } from "vitest";
import { createHouse, finishOnboarding, joinHouse, memberById, startedHouse } from "@/domain/houses";
import { joinTeam, listTeams, setUpTeams } from "@/domain/teams";
import { db, makeUser, resetDb } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z");

beforeEach(async () => {
  await resetDb();
});

async function newHouse() {
  const userId = await makeUser("Ana");
  const h = await createHouse(db, { userId, houseName: "12 Elm St", moneyMode: "etransfer", now: NOW });
  if (!h.ok) throw new Error(h.error);
  return h;
}

test("someone new has the walkthrough to do, and finishing it is remembered", async () => {
  const h = await newHouse();
  expect((await memberById(db, h.memberId))?.onboardedAt).toBeNull();
  await finishOnboarding(db, h.memberId, NOW);
  expect((await memberById(db, h.memberId))?.onboardedAt).toEqual(NOW);
  // Finishing again (opening it from Settings) keeps the first time.
  await finishOnboarding(db, h.memberId, new Date(NOW.getTime() + 60_000));
  expect((await memberById(db, h.memberId))?.onboardedAt).toEqual(NOW);
});

test("the walkthrough knows who started the house", async () => {
  const h = await newHouse();
  const joined = await joinHouse(db, { userId: await makeUser("Ben"), inviteCode: h.inviteCode, now: NOW });
  if (!joined.ok) throw new Error(joined.error);
  expect(await startedHouse(db, h.houseId, h.memberId)).toBe(true);
  expect(await startedHouse(db, h.houseId, joined.memberId)).toBe(false);
});

test("choosing teams at setup creates them, with the person setting up on the first", async () => {
  const h = await newHouse();
  expect(
    await setUpTeams(db, { houseId: h.houseId, memberId: h.memberId, count: 3, weeks: 2, now: NOW }),
  ).toEqual({
    ok: true,
  });
  const teams = await listTeams(db, h.houseId);
  expect(teams.map((t) => t.name)).toEqual(["Team A", "Team B", "Team C"]);
  expect(teams[0].memberIds).toEqual([h.memberId]);
  const house = (await db.query("select team_weeks from houses where id = $1", [h.houseId])).rows[0];
  expect(house.team_weeks).toBe(2);
});

test("someone joining picks their own team, and only one of this house's", async () => {
  const h = await newHouse();
  await setUpTeams(db, { houseId: h.houseId, memberId: h.memberId, count: 2, weeks: 1, now: NOW });
  const joined = await joinHouse(db, { userId: await makeUser("Ben"), inviteCode: h.inviteCode, now: NOW });
  if (!joined.ok) throw new Error(joined.error);
  const [, teamB] = await listTeams(db, h.houseId);
  expect(await joinTeam(db, { memberId: joined.memberId, teamId: teamB.id, now: NOW })).toEqual({ ok: true });
  expect((await listTeams(db, h.houseId))[1].memberIds).toEqual([joined.memberId]);

  const other = await createHouse(db, {
    userId: await makeUser("Cy"),
    houseName: "Other",
    moneyMode: "etransfer",
    now: NOW,
  });
  if (!other.ok) throw new Error(other.error);
  await setUpTeams(db, { houseId: other.houseId, memberId: other.memberId, count: 2, weeks: 1, now: NOW });
  const [foreign] = await listTeams(db, other.houseId);
  expect(await joinTeam(db, { memberId: joined.memberId, teamId: foreign.id, now: NOW })).toEqual({
    ok: false,
    error: "Pick one of this house's teams.",
  });
});
