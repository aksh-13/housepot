import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import { createChore, ensureTurns } from "@/domain/chores";
import { choreBounty, memberBalance } from "@/domain/ledger";
import { savePhoto } from "@/domain/photos";
import {
  addNudge,
  addTeam,
  dutyPeriod,
  listNudges,
  listTeams,
  removeTeam,
  saveTeams,
  sendNudge,
  teamOnDuty,
} from "@/domain/teams";
import { runTick } from "@/domain/tick";
import { assignTurn, claimBounty, expireWaitingTurnsOf, markDone, missTurn } from "@/domain/turns";
import { houseTurns } from "@/domain/views";
import { fakePayments } from "@/providers/payments";
import { fakeSms } from "@/providers/sms";
import { diskStorage } from "@/providers/storage";
import { db, makeHouse, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z"); // Wed noon Toronto, inside Team A's first two weeks
const LATE = new Date("2026-11-13T02:00:01Z"); // just past Thursday's 9pm deadline
const START = "2026-11-09"; // a Monday
const storage = diskStorage(mkdtempSync(path.join(tmpdir(), "housepot-teams-")));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
const sms = fakeSms(db);

let house: TestHouse;
let ana: string;
let ben: string;
let cy: string;
let dee: string;
let teamA: string;
let teamB: string;

/** Four housemates: Ana and Ben on Team A, Cy and Dee on Team B, two weeks each from Mon Nov 9. */
beforeEach(async () => {
  await resetDb();
  house = await makeHouse(4, { moneyMode: "etransfer" });
  [ana, ben, cy, dee] = house.members.map((m) => m.memberId);
  const a = await addTeam(db, { houseId: house.houseId, memberId: ana, now: NOW });
  const b = await addTeam(db, { houseId: house.houseId, memberId: ana, now: NOW });
  if (!a.ok || !b.ok) throw new Error("could not add teams");
  [teamA, teamB] = [a.teamId, b.teamId];
  const saved = await saveTeams(db, {
    houseId: house.houseId,
    memberId: ana,
    weeks: 2,
    startDate: START,
    names: {},
    assignments: { [ana]: teamA, [ben]: teamA, [cy]: teamB, [dee]: teamB },
    now: NOW,
  });
  if (!saved.ok) throw new Error(saved.error);
});

const balances = () => Promise.all([ana, ben, cy, dee].map((m) => memberBalance(db, m)));
const waiting = async () =>
  (await db.query("select id, team_id, due_at, chore_id from turns where status = 'assigned'")).rows[0];
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
async function garbage(teamDuty = true): Promise<string> {
  const r = await createChore(db, {
    houseId: house.houseId,
    memberId: cy,
    name: "Garbage",
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    teamDuty,
    now: NOW,
  });
  if (!r.ok) throw new Error(r.error);
  await ensureTurns(db, house.houseId, NOW);
  return r.choreId;
}

describe("which team is on duty", () => {
  const on = (onDate: string, teamCount = 2, weeks = 2) =>
    dutyPeriod({ teamCount, weeks, startDate: START, onDate });

  test("each team is on for the set number of weeks, then the next, round and round", () => {
    expect(on("2026-11-09")).toEqual({ index: 0, until: "2026-11-22" });
    expect(on("2026-11-22")).toEqual({ index: 0, until: "2026-11-22" });
    expect(on("2026-11-23")).toEqual({ index: 1, until: "2026-12-06" });
    expect(on("2026-12-07")).toEqual({ index: 0, until: "2026-12-20" });
  });

  test("it works for any number of teams and any length", () => {
    expect(on("2026-11-16", 3, 1)).toEqual({ index: 1, until: "2026-11-22" });
    expect(on("2026-11-23", 3, 1)).toEqual({ index: 2, until: "2026-11-29" });
    expect(on("2026-11-30", 3, 1)).toEqual({ index: 0, until: "2026-12-06" });
  });

  test("before the start date the first team is on", () => {
    expect(on("2026-11-01").index).toBe(0);
  });

  test("the house's teams and who is on duty read back", async () => {
    expect((await listTeams(db, house.houseId)).map((t) => [t.name, t.memberIds])).toEqual([
      ["Team A", [ana, ben]],
      ["Team B", [cy, dee]],
    ]);
    expect(await teamOnDuty(db, house.houseId, NOW)).toMatchObject({
      team: { id: teamA },
      until: "2026-11-22",
    });
    const later = new Date("2026-11-25T17:00:00Z");
    expect(await teamOnDuty(db, house.houseId, later)).toMatchObject({
      team: { id: teamB },
      until: "2026-12-06",
    });
  });
});

describe("a chore for the team on duty", () => {
  test("its turn belongs to the team on duty when it is due", async () => {
    await garbage();
    expect((await waiting()).team_id).toBe(teamA);
    const [turn] = await houseTurns(db, house.houseId);
    expect(turn).toMatchObject({ teamId: teamA, teamName: "Team A", choreName: "Garbage" });
  });

  test("anyone on that team can mark it done, and nobody else can", async () => {
    await garbage();
    const turn = await waiting();
    expect(await markDone(db, { turnId: turn.id, memberId: cy, photoId: await photo(cy), now: NOW })).toEqual(
      {
        ok: false,
        error: "This one belongs to Team A.",
      },
    );
    expect(
      (await markDone(db, { turnId: turn.id, memberId: ben, photoId: await photo(ben), now: NOW })).ok,
    ).toBe(true);
    expect(await balances()).toEqual([0, 0, 0, 0]);
  });

  test("a miss charges everyone on the team an equal share, and nobody else", async () => {
    const choreId = await garbage();
    const turn = await waiting();
    expect(await missTurn(db, { turnId: turn.id, now: LATE })).toEqual({ ok: true });
    expect(await balances()).toEqual([-250, -250, 0, 0]);
    expect(await choreBounty(db, choreId)).toBe(500);
    const { rows } = await db.query("select member_id, data from activity where kind = 'missed'");
    expect(rows).toEqual([
      {
        member_id: null,
        data: expect.objectContaining({ choreName: "Garbage", teamName: "Team A", amountCents: 500 }),
      },
    ]);
  });

  test("a price that does not divide evenly still adds up", async () => {
    await saveTeams(db, {
      houseId: house.houseId,
      memberId: ana,
      weeks: 2,
      startDate: START,
      names: {},
      assignments: { [ana]: teamA, [ben]: teamA, [cy]: teamA, [dee]: teamB },
      now: NOW,
    });
    const choreId = await garbage();
    await missTurn(db, { turnId: (await waiting()).id, now: LATE });
    expect(await balances()).toEqual([-167, -167, -166, 0]);
    expect(await choreBounty(db, choreId)).toBe(500);
  });

  test("after a miss anyone in the house can do it and take the money", async () => {
    await garbage();
    const turn = await waiting();
    await missTurn(db, { turnId: turn.id, now: LATE });
    const claimed = await claimBounty(db, {
      turnId: turn.id,
      memberId: dee,
      photoId: await photo(dee),
      now: LATE,
    });
    expect(claimed).toEqual({ ok: true, payoutCents: 500 });
    expect(await balances()).toEqual([-250, -250, 0, 500]);
  });

  test("when the next team comes on duty, the chore's turns go to them", async () => {
    await garbage();
    await db.query("update turns set status = 'done' where status = 'assigned'");
    await ensureTurns(db, house.houseId, new Date("2026-11-24T17:00:00Z"));
    expect((await waiting()).team_id).toBe(teamB);
  });

  test("someone leaving is not charged for a turn that belongs to their team", async () => {
    await garbage();
    await db.tx((t) => expireWaitingTurnsOf(t, ana, NOW));
    await db.tx((t) => expireWaitingTurnsOf(t, ben, NOW));
    expect(await balances()).toEqual([0, 0, 0, 0]);
    expect((await waiting()).team_id).toBe(teamA);
  });

  test("a chore that is not a team chore still goes to one person", async () => {
    await garbage(false);
    expect((await waiting()).team_id).toBeNull();
  });

  test("removing a team frees its people and hands its waiting chores back out", async () => {
    await garbage();
    expect(await removeTeam(db, { teamId: teamA, memberId: cy, now: NOW })).toEqual({ ok: true });
    expect((await listTeams(db, house.houseId)).map((t) => t.name)).toEqual(["Team B"]);
    const { rows } = await db.query("select team_id from members where id = any($1)", [[ana, ben]]);
    expect(rows.every((r) => r.team_id === null)).toBe(true);
    await ensureTurns(db, house.houseId, NOW);
    expect((await waiting()).team_id).toBe(teamB);
  });
});

describe("nudging the team on duty", () => {
  const outbox = async () => (await db.query("select to_phone, body from sms_outbox order by id")).rows;
  const phone = (i: number) => house.members[i].phone;

  test("a house with teams starts with a 'Garbage is full' nudge", async () => {
    expect((await listNudges(db, house.houseId)).map((n) => n.label)).toEqual(["Garbage is full"]);
  });

  test("it emails everyone on the team on duty except the person who pressed it", async () => {
    const [nudge] = await listNudges(db, house.houseId);
    await db.query("delete from sms_outbox");
    const sent = await sendNudge(db, sms, {
      nudgeId: nudge.id,
      memberId: ana,
      now: NOW,
      link: "https://housepot.test/house",
    });
    expect(sent).toEqual({ ok: true, sentTo: 1, teamName: "Team A" });
    expect(await outbox()).toEqual([
      {
        to_phone: phone(1),
        body: "Garbage is full. Ana flagged it, and Team A is on duty until Nov 22. https://housepot.test/house",
      },
    ]);
    const { rows } = await db.query("select member_id, data from activity where kind = 'nudged'");
    expect(rows).toEqual([{ member_id: ana, data: { label: "Garbage is full", teamName: "Team A" } }]);
  });

  test("someone on the other team can nudge, and the whole on-duty team hears", async () => {
    const [nudge] = await listNudges(db, house.houseId);
    await db.query("delete from sms_outbox");
    const sent = await sendNudge(db, sms, {
      nudgeId: nudge.id,
      memberId: dee,
      now: NOW,
      link: "https://housepot.test/house",
    });
    expect(sent).toMatchObject({ ok: true, sentTo: 2 });
    expect((await outbox()).map((m) => m.to_phone).sort()).toEqual([phone(0), phone(1)].sort());
  });

  test("the same nudge cannot be sent again within the hour", async () => {
    const [nudge] = await listNudges(db, house.houseId);
    const args = { nudgeId: nudge.id, memberId: dee, link: "https://housepot.test/house" };
    await sendNudge(db, sms, { ...args, now: NOW });
    await db.query("delete from sms_outbox");
    const soon = new Date(NOW.getTime() + 59 * 60_000);
    expect(await sendNudge(db, sms, { ...args, now: soon })).toEqual({
      ok: false,
      error: "That was already sent in the last hour.",
    });
    expect(await outbox()).toEqual([]);
    const later = new Date(NOW.getTime() + 61 * 60_000);
    expect((await sendNudge(db, sms, { ...args, now: later })).ok).toBe(true);
  });

  test("a house can add its own nudges", async () => {
    expect(
      (
        await addNudge(db, {
          houseId: house.houseId,
          memberId: ben,
          label: "  Dishes are piling up  ",
          now: LATE,
        })
      ).ok,
    ).toBe(true);
    expect((await listNudges(db, house.houseId)).map((n) => n.label)).toEqual([
      "Garbage is full",
      "Dishes are piling up",
    ]);
    expect(await addNudge(db, { houseId: house.houseId, memberId: ben, label: "  ", now: NOW })).toEqual({
      ok: false,
      error: "Say what the nudge is.",
    });
  });

  test("only housemates of the house can nudge", async () => {
    const other = await makeHouse(1, { moneyMode: "etransfer" });
    const [nudge] = await listNudges(db, house.houseId);
    expect(
      await sendNudge(db, sms, {
        nudgeId: nudge.id,
        memberId: other.members[0].memberId,
        now: NOW,
        link: "x",
      }),
    ).toEqual({ ok: false, error: "Only housemates can do that." });
  });
});

describe("the scheduler and team chores", () => {
  const texts = async () => (await db.query("select to_phone, body from sms_outbox order by id")).rows;
  const tick = (at: string) =>
    runTick(db, { sms, payments: fakePayments() }, new Date(at), "https://housepot.test");

  test("on the day it is due, everyone on the team is reminded, and nobody else", async () => {
    await garbage();
    await db.query("delete from sms_outbox");
    await tick("2026-11-12T15:00:00Z"); // Thursday 10am Toronto
    const sent = await texts();
    expect(sent.map((m) => m.to_phone).sort()).toEqual(
      [house.members[0].phone, house.members[1].phone].sort(),
    );
    const has = (await db.query("select assignee_member_id from turns where status = 'assigned'")).rows[0]
      .assignee_member_id;
    const name = has === ana ? "Ana" : "Ben";
    expect(sent.map((m) => m.body)).toEqual([
      ...new Set([
        `Garbage is your team's today, by 9:00 PM. ${name} has it, and anyone on the team can do it with a photo: https://housepot.test/house`,
      ]),
      `Garbage is your team's today, by 9:00 PM. ${name} has it, and anyone on the team can do it with a photo: https://housepot.test/house`,
    ]);
  });

  test("a missed team chore charges the team and tells everyone what happened", async () => {
    await garbage();
    await db.query("delete from sms_outbox");
    const summary = await tick("2026-11-13T02:05:00Z");
    expect(summary.misses).toBe(1);
    expect(await balances()).toEqual([-250, -250, 0, 0]);
    const sent = await texts();
    const toAna = sent.filter((m) => m.to_phone === house.members[0].phone).map((m) => m.body);
    const toCy = sent.filter((m) => m.to_phone === house.members[2].phone).map((m) => m.body);
    expect(toAna).toEqual([
      "Your team missed Garbage. The $5 was split between everyone on the team, and your balance is now -$2.50. Do it before a housemate does to win it back: https://housepot.test/house",
    ]);
    expect(toCy).toEqual([
      "Garbage is open: +$5 to whoever does it, with a photo. https://housepot.test/house",
    ]);
  });
});

describe("who on the team has which chore", () => {
  async function chore(name: string): Promise<void> {
    const r = await createChore(db, {
      houseId: house.houseId,
      memberId: cy,
      name,
      schedule: { kind: "weekly", weekday: 4 },
      deadlineTime: "21:00",
      teamDuty: true,
      now: NOW,
    });
    if (!r.ok) throw new Error(r.error);
  }
  const whoHas = async () =>
    Object.fromEntries(
      (
        await db.query(
          "select c.name, t.assignee_member_id from turns t join chores c on c.id = t.chore_id where t.status = 'assigned'",
        )
      ).rows.map((r) => [r.name, r.assignee_member_id]),
    );

  test("chores are spread across the team, so each person gets one before anyone gets two", async () => {
    await chore("Garbage");
    await chore("Bathroom");
    await chore("Kitchen");
    await ensureTurns(db, house.houseId, NOW);
    const has = await whoHas();
    expect([has.Garbage, has.Bathroom].sort()).toEqual([ana, ben].sort());
    expect([ana, ben]).toContain(has.Kitchen);
  });

  test("the same chore moves to the next teammate the following week", async () => {
    await chore("Garbage");
    await ensureTurns(db, house.houseId, NOW);
    const first = (await whoHas()).Garbage;
    await db.query("update turns set status = 'done' where status = 'assigned'");
    await ensureTurns(db, house.houseId, NOW);
    const second = (await whoHas()).Garbage;
    expect([first, second].sort()).toEqual([ana, ben].sort());
  });

  test("anyone in the house can give a team chore to someone else on that team", async () => {
    await chore("Garbage");
    await ensureTurns(db, house.houseId, NOW);
    const turn = await waiting();
    const other = (await whoHas()).Garbage === ana ? ben : ana;
    expect(await assignTurn(db, { turnId: turn.id, memberId: dee, toMemberId: other, now: NOW })).toEqual({
      ok: true,
    });
    expect((await whoHas()).Garbage).toBe(other);
    const [view] = await houseTurns(db, house.houseId);
    expect(view).toMatchObject({ teamName: "Team A", assigneeMemberId: other });
  });

  test("a team chore cannot be given to someone on another team", async () => {
    await chore("Garbage");
    await ensureTurns(db, house.houseId, NOW);
    const turn = await waiting();
    expect(await assignTurn(db, { turnId: turn.id, memberId: ana, toMemberId: cy, now: NOW })).toEqual({
      ok: false,
      error: "Pick someone on Team A.",
    });
  });

  test("a chore that goes to one person at a time cannot be handed over this way", async () => {
    await garbage(false);
    const turn = await waiting();
    expect(await assignTurn(db, { turnId: turn.id, memberId: ana, toMemberId: ben, now: NOW })).toEqual({
      ok: false,
      error: "Only a team chore can be given to someone else.",
    });
  });

  test("whoever has it, a teammate can still do it, and a miss is still shared", async () => {
    await chore("Garbage");
    await ensureTurns(db, house.houseId, NOW);
    const turn = await waiting();
    const has = (await whoHas()).Garbage;
    const teammate = has === ana ? ben : ana;
    expect(
      (await markDone(db, { turnId: turn.id, memberId: teammate, photoId: await photo(teammate), now: NOW }))
        .ok,
    ).toBe(true);

    await ensureTurns(db, house.houseId, NOW);
    await missTurn(db, { turnId: (await waiting()).id, now: new Date("2026-11-20T02:00:01Z") });
    expect(await balances()).toEqual([-250, -250, 0, 0]);
  });
});
