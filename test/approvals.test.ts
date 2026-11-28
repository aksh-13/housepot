import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";
import {
  APPROVAL_WINDOW_MS,
  pendingSubmissions,
  submitClaim,
  submitDone,
  voteOnSubmission,
} from "@/domain/approvals";
import { createChore, ensureTurns } from "@/domain/chores";
import { choreBounty, memberBalance } from "@/domain/ledger";
import { savePhoto } from "@/domain/photos";
import { settleUpHouse } from "@/domain/settleup";
import { addTeam, saveTeams } from "@/domain/teams";
import { runTick } from "@/domain/tick";
import { missTurn } from "@/domain/turns";
import { fakePayments } from "@/providers/payments";
import { fakeSms } from "@/providers/sms";
import { diskStorage } from "@/providers/storage";
import { db, makeHouse, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z"); // Wed noon Toronto; garbage is due Thu 21:00
const LATE = new Date("2026-11-13T02:00:01Z"); // one second past the deadline
const later = (d: Date, hours: number) => new Date(d.getTime() + hours * 3600_000);
const storage = diskStorage(mkdtempSync(path.join(tmpdir(), "housepot-approvals-")));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

let house: TestHouse;
let ids: string[];
let choreId: string;

async function setUp(count: number, opts: { moneyMode?: "card" | "etransfer" } = {}) {
  house = await makeHouse(count, opts);
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
  await ensureTurns(db, house.houseId, NOW);
}

async function photo(memberId: string, houseId = house.houseId): Promise<string> {
  const r = await savePhoto(db, storage, {
    houseId,
    memberId,
    bytes: JPEG,
    contentType: "image/jpeg",
    now: NOW,
  });
  if (!r.ok) throw new Error(r.error);
  return r.photoId;
}

const waitingTurnId = async () =>
  (await db.query<{ id: string }>("select id from turns where status = 'assigned'")).rows[0].id;
const turnRow = async (id: string) => (await db.query("select * from turns where id = $1", [id])).rows[0];

async function sendDone(memberId = ids[0], now = NOW, photos = 1) {
  const photoIds: string[] = [];
  for (let i = 0; i < photos; i++) photoIds.push(await photo(memberId));
  const sent = await submitDone(db, { turnId: await waitingTurnId(), memberId, photoIds, now });
  if (!sent.ok) throw new Error(sent.error);
  return sent;
}

const vote = (submissionId: string, memberId: string, approve: boolean, now = NOW) =>
  voteOnSubmission(db, { submissionId, memberId, approve, now });

const tick = (now: Date) =>
  runTick(db, { sms: fakeSms(db), payments: fakePayments() }, now, "https://housepot.test");

beforeEach(async () => {
  await resetDb();
});

describe("proof waits for the house", () => {
  test("sending proof moves no money and keeps the turn waiting until the house votes", async () => {
    await setUp(3);
    const turnId = await waitingTurnId();
    const sent = await sendDone();
    expect(sent.decision).toBe("pending");
    expect(await turnRow(turnId)).toMatchObject({ status: "assigned" });
    expect((await db.query("select count(*)::int as n from turns")).rows[0].n).toBe(1);
    const [p] = await pendingSubmissions(db, house.houseId);
    expect(p).toMatchObject({ choreName: "Garbage", memberId: ids[0], yes: 0, no: 0, needed: 2 });
  });

  test("more than half of the others saying it looks done approves it, and only then is it paid", async () => {
    await setUp(4);
    // Money left on the chore from an earlier miss, waiting for whoever does it on time.
    const turnId = await waitingTurnId();
    await missTurn(db, { turnId, now: LATE });
    await ensureTurns(db, house.houseId, LATE);
    const next = await waitingTurnId();
    const nextDone = await submitDone(db, {
      turnId: next,
      memberId: ids[1],
      photoIds: [await photo(ids[1])],
      now: later(LATE, 24 * 5),
    });
    if (!nextDone.ok) throw new Error(nextDone.error);

    expect((await vote(nextDone.submissionId, ids[0], true, later(LATE, 24 * 5))).ok).toBe(true);
    expect(await memberBalance(db, ids[1])).toBe(2000);
    const second = await vote(nextDone.submissionId, ids[2], true, later(LATE, 24 * 5));
    expect(second).toMatchObject({ ok: true, decision: "approved", payoutCents: 500 });
    expect(await memberBalance(db, ids[1])).toBe(2500);
    expect(await turnRow(next)).toMatchObject({ status: "done", completed_by_member_id: ids[1] });
  });

  test("a majority saying not done before the deadline lets them send it again", async () => {
    await setUp(3);
    const turnId = await waitingTurnId();
    const sent = await sendDone();
    await vote(sent.submissionId, ids[1], false);
    const r = await vote(sent.submissionId, ids[2], false);
    expect(r).toMatchObject({ ok: true, decision: "rejected" });
    expect(await turnRow(turnId)).toMatchObject({ status: "assigned" });
    expect(await memberBalance(db, ids[0])).toBe(2000);
    expect((await sendDone(ids[0], later(NOW, 1))).decision).toBe("pending");
  });

  test("rejected after the deadline, the chore expires as if nothing had been sent", async () => {
    await setUp(3);
    const turnId = await waitingTurnId();
    const sent = await sendDone();
    await vote(sent.submissionId, ids[1], false, LATE);
    await vote(sent.submissionId, ids[2], false, LATE);
    expect(await turnRow(turnId)).toMatchObject({ status: "open", opened_reason: "dispute" });
    expect(await memberBalance(db, ids[0])).toBe(1500);
    expect(await choreBounty(db, choreId)).toBe(500);
  });

  test("proof sent before the deadline is on time, however long the vote takes", async () => {
    await setUp(3);
    const turnId = await waitingTurnId();
    await sendDone();
    const summary = await tick(LATE);
    expect(summary.misses).toBe(0);
    expect(await turnRow(turnId)).toMatchObject({ status: "assigned" });
    expect(await memberBalance(db, ids[0])).toBe(2000);
  });

  test("with no majority either way after 48 hours, it counts", async () => {
    await setUp(3);
    const turnId = await waitingTurnId();
    const sent = await sendDone();
    await vote(sent.submissionId, ids[1], true);
    await vote(sent.submissionId, ids[2], false);
    expect((await tick(new Date(NOW.getTime() + APPROVAL_WINDOW_MS - 60_000))).approvalsClosed).toBe(0);
    const summary = await tick(new Date(NOW.getTime() + APPROVAL_WINDOW_MS));
    expect(summary.approvalsClosed).toBe(1);
    expect(summary.misses).toBe(0);
    expect(await turnRow(turnId)).toMatchObject({ status: "done" });
    const row = (
      await db.query("select status, decided_by from submissions where id = $1", [sent.submissionId])
    ).rows[0];
    expect(row).toEqual({ status: "approved", decided_by: "timeout" });
  });

  test("in a one-person house there is nobody to ask, so it counts straight away", async () => {
    await setUp(1);
    const sent = await sendDone();
    expect(sent.decision).toBe("approved");
  });
});

describe("photos and votes", () => {
  test("up to four photos, from this house, are kept with the proof", async () => {
    await setUp(3);
    const sent = await sendDone(ids[0], NOW, 4);
    const [p] = await pendingSubmissions(db, house.houseId);
    expect(p.id).toBe(sent.submissionId);
    expect(p.photoIds).toHaveLength(4);
  });

  test("no photo, five photos, or another house's photo is refused", async () => {
    await setUp(3);
    const turnId = await waitingTurnId();
    const send = (photoIds: string[]) => submitDone(db, { turnId, memberId: ids[0], photoIds, now: NOW });
    expect(await send([])).toEqual({ ok: false, error: "Add a photo of the finished chore." });
    const five = await Promise.all([0, 1, 2, 3, 4].map(() => photo(ids[0])));
    expect(await send(five)).toEqual({ ok: false, error: "Send up to 4 photos." });
    const other = await makeHouse(1);
    const foreign = await photo(other.members[0].memberId, other.houseId);
    expect(await send([foreign])).toEqual({ ok: false, error: "Add a photo of the finished chore." });
  });

  test("you cannot vote on your own proof, outsiders cannot vote, and a vote can be changed", async () => {
    await setUp(3);
    const sent = await sendDone();
    expect(await vote(sent.submissionId, ids[0], true)).toEqual({
      ok: false,
      error: "You cannot vote on your own chore.",
    });
    const other = await makeHouse(1);
    expect(await vote(sent.submissionId, other.members[0].memberId, true)).toEqual({
      ok: false,
      error: "Only housemates can vote.",
    });
    await vote(sent.submissionId, ids[1], false);
    await vote(sent.submissionId, ids[1], true);
    const [p] = await pendingSubmissions(db, house.houseId);
    expect(p).toMatchObject({ yes: 1, no: 0 });
  });

  test("a decided proof takes no more votes", async () => {
    await setUp(2);
    const sent = await sendDone();
    expect(await vote(sent.submissionId, ids[1], true)).toMatchObject({ decision: "approved" });
    expect(await vote(sent.submissionId, ids[1], false)).toEqual({
      ok: false,
      error: "The house has already decided this one.",
    });
  });
});

describe("claiming an expired chore", () => {
  test("the first proof is the one voted on; a second claim waits", async () => {
    await setUp(3);
    const turnId = await waitingTurnId();
    await missTurn(db, { turnId, now: LATE });
    const first = await submitClaim(db, {
      turnId,
      memberId: ids[1],
      photoIds: [await photo(ids[1])],
      now: LATE,
    });
    expect(first).toMatchObject({ ok: true, decision: "pending" });
    expect(
      await submitClaim(db, { turnId, memberId: ids[2], photoIds: [await photo(ids[2])], now: LATE }),
    ).toEqual({
      ok: false,
      error: "Someone already sent proof for this. The house is voting on it.",
    });
  });

  test("a team cannot claim back a team chore that expired on it", async () => {
    await setUp(4, { moneyMode: "etransfer" });
    const teamA = await addTeam(db, { houseId: house.houseId, memberId: ids[0], now: NOW });
    const teamB = await addTeam(db, { houseId: house.houseId, memberId: ids[0], now: NOW });
    if (!teamA.ok || !teamB.ok) throw new Error("teams");
    await saveTeams(db, {
      houseId: house.houseId,
      memberId: ids[0],
      weeks: 1,
      startDate: "2026-11-09",
      names: {},
      assignments: {
        [ids[0]]: teamA.teamId,
        [ids[1]]: teamA.teamId,
        [ids[2]]: teamB.teamId,
        [ids[3]]: teamB.teamId,
      },
      now: NOW,
    });
    await db.query("update chores set team_duty = true where id = $1", [choreId]);
    await db.query("update turns set status = 'cancelled' where status = 'assigned'");
    await ensureTurns(db, house.houseId, NOW);
    const turnId = await waitingTurnId();
    expect((await turnRow(turnId)).team_id).toBe(teamA.teamId);
    await missTurn(db, { turnId, now: LATE });
    expect(
      await submitClaim(db, { turnId, memberId: ids[1], photoIds: [await photo(ids[1])], now: LATE }),
    ).toEqual({
      ok: false,
      error: "This expired on you, so the money goes to whoever else does it.",
    });
    expect(
      (await submitClaim(db, { turnId, memberId: ids[2], photoIds: [await photo(ids[2])], now: LATE })).ok,
    ).toBe(true);
  });

  test("money set aside for a claim being voted on survives a settle-up and is paid if approved", async () => {
    await setUp(3, { moneyMode: "etransfer" });
    const turnId = await waitingTurnId();
    await missTurn(db, { turnId, now: LATE });
    const claim = await submitClaim(db, {
      turnId,
      memberId: ids[1],
      photoIds: [await photo(ids[1])],
      now: LATE,
    });
    if (!claim.ok) throw new Error(claim.error);

    await settleUpHouse(db, { houseId: house.houseId, now: later(LATE, 1), reason: "early" });
    expect(await choreBounty(db, choreId)).toBe(500);
    expect(await turnRow(turnId)).toMatchObject({ status: "open" });

    await vote(claim.submissionId, ids[0], true, later(LATE, 2));
    const r = await vote(claim.submissionId, ids[2], true, later(LATE, 2));
    expect(r).toMatchObject({ ok: true, decision: "approved", payoutCents: 500 });
    expect(await choreBounty(db, choreId)).toBe(0);
    expect(await turnRow(turnId)).toMatchObject({ status: "claimed", completed_by_member_id: ids[1] });
  });
});
