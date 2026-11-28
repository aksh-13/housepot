import { beforeEach, expect, test } from "vitest";
import { createChore, ensureTurns, listChores, updateChore } from "@/domain/chores";
import { joinHouse } from "@/domain/houses";
import { runTick } from "@/domain/tick";
import { openProposals, PROPOSAL_WINDOW_MS, voteOnProposal } from "@/domain/worth";
import { fakePayments } from "@/providers/payments";
import { fakeSms } from "@/providers/sms";
import { db, makeHouse, makeUser, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z");
const THURSDAY = { kind: "weekly" as const, weekday: 4 };

let house: TestHouse;
let ids: string[];

beforeEach(async () => {
  await resetDb();
});

async function setUp(count: number) {
  house = await makeHouse(count, { moneyMode: "etransfer" });
  ids = house.members.map((m) => m.memberId);
}

const add = (memberId: string, worthCents = 700, name = "Garbage") =>
  createChore(db, {
    houseId: house.houseId,
    memberId,
    name,
    schedule: THURSDAY,
    deadlineTime: "21:00",
    skipPriceCents: worthCents,
    now: NOW,
  });

const turnCount = async () => (await db.query("select count(*)::int as n from turns")).rows[0].n;
const tick = (now: Date) =>
  runTick(db, { sms: fakeSms(db), payments: fakePayments() }, now, "https://housepot.test");

test("while nobody else is in the house, whoever sets it up decides what each chore is worth", async () => {
  await setUp(1);
  const r = await add(ids[0]);
  expect(r).toMatchObject({ ok: true, proposed: false });
  expect((await listChores(db, house.houseId))[0]).toMatchObject({ skipPriceCents: 700, agreed: true });
  await ensureTurns(db, house.houseId, NOW);
  expect(await turnCount()).toBe(1);
  expect(await openProposals(db, house.houseId)).toEqual([]);
});

test("once others have joined, a new chore waits for most of the house to agree, and gets no turns until then", async () => {
  await setUp(4);
  const r = await add(ids[0]);
  if (!r.ok) throw new Error(r.error);
  expect(r.proposed).toBe(true);
  await ensureTurns(db, house.houseId, NOW);
  expect(await turnCount()).toBe(0);

  const [p] = await openProposals(db, house.houseId);
  expect(p).toMatchObject({ kind: "new", worthCents: 700, needed: 2, yes: 0 });
  expect(await voteOnProposal(db, { proposalId: p.id, memberId: ids[1], agree: true, now: NOW })).toEqual({
    ok: true,
    decision: "open",
  });
  expect(await voteOnProposal(db, { proposalId: p.id, memberId: ids[2], agree: true, now: NOW })).toEqual({
    ok: true,
    decision: "accepted",
  });
  expect((await listChores(db, house.houseId))[0]).toMatchObject({ agreed: true, skipPriceCents: 700 });
  await ensureTurns(db, house.houseId, NOW);
  expect(await turnCount()).toBe(1);
});

test("a new chore most of the house says no to never starts", async () => {
  await setUp(3);
  await add(ids[0]);
  const [p] = await openProposals(db, house.houseId);
  await voteOnProposal(db, { proposalId: p.id, memberId: ids[1], agree: false, now: NOW });
  const r = await voteOnProposal(db, { proposalId: p.id, memberId: ids[2], agree: false, now: NOW });
  expect(r).toEqual({ ok: true, decision: "rejected" });
  expect(await listChores(db, house.houseId)).toEqual([]);
});

test("a new worth for a chore in use is a proposal; the old worth applies until it is agreed", async () => {
  await setUp(1);
  const r = await add(ids[0], 500);
  if (!r.ok) throw new Error(r.error);
  const joined = await joinHouse(db, {
    userId: await makeUser("Ben"),
    inviteCode: house.inviteCode,
    now: NOW,
  });
  if (!joined.ok) throw new Error(joined.error);

  const edit = await updateChore(db, { choreId: r.choreId, memberId: ids[0], skipPriceCents: 900, now: NOW });
  expect(edit).toEqual({ ok: true, proposed: true });
  expect((await listChores(db, house.houseId))[0].skipPriceCents).toBe(500);
  expect(
    await updateChore(db, { choreId: r.choreId, memberId: ids[0], skipPriceCents: 1000, now: NOW }),
  ).toEqual({
    ok: false,
    error: "A new worth for this chore is already being voted on.",
  });

  const [p] = await openProposals(db, house.houseId);
  expect(p).toMatchObject({ kind: "worth", worthCents: 900, currentCents: 500, needed: 1 });
  await voteOnProposal(db, { proposalId: p.id, memberId: joined.memberId, agree: true, now: NOW });
  expect((await listChores(db, house.houseId))[0].skipPriceCents).toBe(900);
});

test("renaming or rescheduling a chore needs no vote", async () => {
  await setUp(1);
  const r = await add(ids[0]);
  if (!r.ok) throw new Error(r.error);
  await joinHouse(db, { userId: await makeUser("Ben"), inviteCode: house.inviteCode, now: NOW });
  expect(await updateChore(db, { choreId: r.choreId, memberId: ids[0], name: "Bins", now: NOW })).toEqual({
    ok: true,
    proposed: false,
  });
  expect((await listChores(db, house.houseId))[0].name).toBe("Bins");
  expect(await openProposals(db, house.houseId)).toEqual([]);
});

test("the person who proposed it cannot vote on it, and outsiders cannot either", async () => {
  await setUp(3);
  await add(ids[0]);
  const [p] = await openProposals(db, house.houseId);
  expect(await voteOnProposal(db, { proposalId: p.id, memberId: ids[0], agree: true, now: NOW })).toEqual({
    ok: false,
    error: "You proposed this, so your yes is already counted.",
  });
  const other = await makeHouse(1);
  expect(
    await voteOnProposal(db, {
      proposalId: p.id,
      memberId: other.members[0].memberId,
      agree: true,
      now: NOW,
    }),
  ).toEqual({ ok: false, error: "Only housemates can vote." });
});

test("a proposal without a majority after three days lapses, and a new chore with it", async () => {
  await setUp(3);
  await add(ids[0]);
  const [p] = await openProposals(db, house.houseId);
  await voteOnProposal(db, { proposalId: p.id, memberId: ids[1], agree: true, now: NOW });
  await tick(new Date(NOW.getTime() + PROPOSAL_WINDOW_MS - 60_000));
  expect(await openProposals(db, house.houseId)).toHaveLength(1);
  await tick(new Date(NOW.getTime() + PROPOSAL_WINDOW_MS));
  expect(await openProposals(db, house.houseId)).toEqual([]);
  expect(await listChores(db, house.houseId)).toEqual([]);
  const status = (await db.query("select status from chore_proposals where id = $1", [p.id])).rows[0].status;
  expect(status).toBe("lapsed");
});
