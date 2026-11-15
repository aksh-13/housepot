import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import { createChore, ensureTurns } from "@/domain/chores";
import { openDisputes, raiseDispute, voteDispute } from "@/domain/disputes";
import { choreBounty, memberBalance } from "@/domain/ledger";
import { savePhoto } from "@/domain/photos";
import { claimBounty, markDone, missTurn } from "@/domain/turns";
import { diskStorage } from "@/providers/storage";
import { db, makeHouse, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z"); // Wed noon; garbage due Thu 21:00 Toronto
const LATE = new Date("2026-11-13T02:00:01Z");
const HOUR = 3600_000;
const after = (base: Date, hours: number) => new Date(base.getTime() + hours * HOUR);
const storage = diskStorage(mkdtempSync(path.join(tmpdir(), "housepot-test-")));

let house: TestHouse;
let choreId: string;
let ids: string[];

beforeEach(resetDb);

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
  await ensureTurns(db, house.houseId, NOW);
}

async function photo(memberId: string) {
  const r = await savePhoto(db, storage, {
    houseId: house.houseId,
    memberId,
    bytes: Buffer.from([1, 2, 3]),
    contentType: "image/jpeg",
    now: NOW,
  });
  if (!r.ok) throw new Error(r.error);
  return r.photoId;
}

const waitingTurnId = async () =>
  (await db.query("select id from turns where status = 'assigned'")).rows[0].id;
const turnRow = async (id: string) => (await db.query("select * from turns where id = $1", [id])).rows[0];

/** The first housemate marks their turn done on time. Returns the turn id. */
async function doneByFirst(): Promise<string> {
  const turnId = await waitingTurnId();
  const r = await markDone(db, { turnId, memberId: ids[0], photoId: await photo(ids[0]), now: NOW });
  if (!r.ok) throw new Error(r.error);
  return turnId;
}

test("in a house of four, the raiser plus one more is enough: the turn counts as missed", async () => {
  await setup(4);
  const turnId = await doneByFirst();
  const raised = await raiseDispute(db, { turnId, memberId: ids[1], now: after(NOW, 1) });
  expect(raised).toMatchObject({ ok: true, passed: false });
  expect(await memberBalance(db, ids[0])).toBe(2000);

  if (!raised.ok) throw new Error("setup");
  const vote = await voteDispute(db, {
    disputeId: raised.disputeId,
    memberId: ids[2],
    agree: true,
    now: after(NOW, 2),
  });
  expect(vote).toMatchObject({ ok: true, passed: true });
  expect(await memberBalance(db, ids[0])).toBe(1500);
  expect(await choreBounty(db, choreId)).toBe(500);
  expect(await turnRow(turnId)).toMatchObject({
    status: "open",
    opened_reason: "dispute",
    completed_by_member_id: null,
    photo_id: null,
  });
  expect((await db.query("select status from disputes")).rows[0].status).toBe("passed");
});

test("in a house of three, the raiser alone is not enough; the other housemate settles it", async () => {
  await setup(3);
  const turnId = await doneByFirst();
  const raised = await raiseDispute(db, { turnId, memberId: ids[1], now: after(NOW, 1) });
  if (!raised.ok) throw new Error(raised.error);
  expect(raised.passed).toBe(false);
  expect((await turnRow(turnId)).status).toBe("done");

  const vote = await voteDispute(db, {
    disputeId: raised.disputeId,
    memberId: ids[2],
    agree: true,
    now: after(NOW, 2),
  });
  expect(vote).toMatchObject({ ok: true, passed: true });
  expect(await memberBalance(db, ids[0])).toBe(1500);
});

test("in a house of two, the other housemate's dispute passes on its own", async () => {
  await setup(2);
  const turnId = await doneByFirst();
  const raised = await raiseDispute(db, { turnId, memberId: ids[1], now: after(NOW, 1) });
  expect(raised).toMatchObject({ ok: true, passed: true });
});

test("a vote against does not count towards passing, and a voter can change their mind", async () => {
  await setup(4);
  const turnId = await doneByFirst();
  const raised = await raiseDispute(db, { turnId, memberId: ids[1], now: after(NOW, 1) });
  if (!raised.ok) throw new Error(raised.error);
  const no = await voteDispute(db, {
    disputeId: raised.disputeId,
    memberId: ids[2],
    agree: false,
    now: after(NOW, 2),
  });
  expect(no).toMatchObject({ ok: true, passed: false });
  const yes = await voteDispute(db, {
    disputeId: raised.disputeId,
    memberId: ids[2],
    agree: true,
    now: after(NOW, 3),
  });
  expect(yes).toMatchObject({ ok: true, passed: true });
});

test("the person being disputed cannot raise or vote", async () => {
  await setup(4);
  const turnId = await doneByFirst();
  expect(await raiseDispute(db, { turnId, memberId: ids[0], now: after(NOW, 1) })).toEqual({
    ok: false,
    error: "You cannot dispute your own chore.",
  });
  const raised = await raiseDispute(db, { turnId, memberId: ids[1], now: after(NOW, 1) });
  if (!raised.ok) throw new Error(raised.error);
  const vote = await voteDispute(db, {
    disputeId: raised.disputeId,
    memberId: ids[0],
    agree: false,
    now: after(NOW, 2),
  });
  expect(vote.ok).toBe(false);
});

test("people outside the house, or who have not paid, cannot raise or vote", async () => {
  await setup(4);
  const turnId = await doneByFirst();
  const other = await makeHouse(1);
  expect(
    (await raiseDispute(db, { turnId, memberId: other.members[0].memberId, now: after(NOW, 1) })).ok,
  ).toBe(false);

  const raised = await raiseDispute(db, { turnId, memberId: ids[1], now: after(NOW, 1) });
  if (!raised.ok) throw new Error(raised.error);
  await db.query("update members set status = 'pending' where id = $1", [ids[2]]);
  const vote = await voteDispute(db, {
    disputeId: raised.disputeId,
    memberId: ids[2],
    agree: true,
    now: after(NOW, 2),
  });
  expect(vote.ok).toBe(false);
  expect((await turnRow(turnId)).status).toBe("done");
});

test("a dispute cannot be raised more than 24 hours after the chore was marked done", async () => {
  await setup(3);
  const turnId = await doneByFirst();
  expect(await raiseDispute(db, { turnId, memberId: ids[1], now: after(NOW, 25) })).toEqual({
    ok: false,
    error: "The 24 hours to dispute this have passed.",
  });
});

test("a vote after 24 hours is refused and the dispute is closed", async () => {
  await setup(3);
  const turnId = await doneByFirst();
  const raised = await raiseDispute(db, { turnId, memberId: ids[1], now: after(NOW, 23) });
  if (!raised.ok) throw new Error(raised.error);
  const vote = await voteDispute(db, {
    disputeId: raised.disputeId,
    memberId: ids[2],
    agree: true,
    now: after(NOW, 25),
  });
  expect(vote.ok).toBe(false);
  expect((await db.query("select status from disputes")).rows[0].status).toBe("expired");
  expect(await memberBalance(db, ids[0])).toBe(2000);
});

test("a turn can be disputed only once, and only when it is finished", async () => {
  await setup(4);
  const waiting = await waitingTurnId();
  expect((await raiseDispute(db, { turnId: waiting, memberId: ids[1], now: NOW })).ok).toBe(false);

  const turnId = await doneByFirst();
  await raiseDispute(db, { turnId, memberId: ids[1], now: after(NOW, 1) });
  expect(await raiseDispute(db, { turnId, memberId: ids[2], now: after(NOW, 2) })).toEqual({
    ok: false,
    error: "This has already been disputed.",
  });
});

test("a passed dispute on a claim takes the payout back and reopens the bounty", async () => {
  await setup(3);
  const turnId = await waitingTurnId();
  await missTurn(db, { turnId, now: LATE });
  await claimBounty(db, { turnId, memberId: ids[1], photoId: await photo(ids[1]), now: LATE });
  expect(await memberBalance(db, ids[1])).toBe(2500);

  // The accused is the claimer (ids[1]); the other two are ids[0] and ids[2].
  const raised = await raiseDispute(db, { turnId, memberId: ids[0], now: after(LATE, 1) });
  if (!raised.ok) throw new Error(raised.error);
  const vote = await voteDispute(db, {
    disputeId: raised.disputeId,
    memberId: ids[2],
    agree: true,
    now: after(LATE, 2),
  });
  expect(vote).toMatchObject({ ok: true, passed: true });

  expect(await memberBalance(db, ids[1])).toBe(2000); // payout returned, no extra charge
  expect(await memberBalance(db, ids[0])).toBe(1500); // the original miss still stands
  expect(await choreBounty(db, choreId)).toBe(500);
  expect(await turnRow(turnId)).toMatchObject({ status: "open", opened_reason: "dispute", payout_cents: 0 });

  const again = await claimBounty(db, {
    turnId,
    memberId: ids[2],
    photoId: await photo(ids[2]),
    now: after(LATE, 3),
  });
  expect(again).toEqual({ ok: true, payoutCents: 500 });
});

test("a passed dispute on an on-time turn that collected a bonus takes the bonus back too", async () => {
  await setup(3);
  const first = await waitingTurnId();
  await missTurn(db, { turnId: first, now: LATE }); // ids[0] misses: bounty 500
  await ensureTurns(db, house.houseId, LATE);
  const second = await waitingTurnId();
  const doneAt = after(LATE, 24);
  await markDone(db, { turnId: second, memberId: ids[1], photoId: await photo(ids[1]), now: doneAt });
  expect(await memberBalance(db, ids[1])).toBe(2500);

  const raised = await raiseDispute(db, { turnId: second, memberId: ids[0], now: after(doneAt, 1) });
  if (!raised.ok) throw new Error(raised.error);
  await voteDispute(db, {
    disputeId: raised.disputeId,
    memberId: ids[2],
    agree: true,
    now: after(doneAt, 2),
  });

  expect(await memberBalance(db, ids[1])).toBe(1500); // bonus 500 back, plus their own 500 charge
  expect(await choreBounty(db, choreId)).toBe(1000);
  expect((await turnRow(second)).status).toBe("open");
});

test("open disputes are listed with the votes so far and how many are needed", async () => {
  await setup(4);
  const turnId = await doneByFirst();
  const raised = await raiseDispute(db, { turnId, memberId: ids[1], now: after(NOW, 1) });
  if (!raised.ok) throw new Error(raised.error);
  expect(await openDisputes(db, house.houseId, after(NOW, 2))).toEqual([
    {
      id: raised.disputeId,
      turnId,
      choreName: "Garbage",
      accusedMemberId: ids[0],
      accusedName: "Ana",
      raisedByName: "Ben",
      photoId: expect.any(String),
      agreeCount: 1,
      needed: 2,
      votes: { [ids[1]]: true },
      closesAt: after(NOW, 24),
    },
  ]);
  expect(await openDisputes(db, house.houseId, after(NOW, 25))).toEqual([]);
});
