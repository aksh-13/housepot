import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import { ensureTurns } from "@/domain/chores";
import { choreBounty, memberBalance, transfer } from "@/domain/ledger";
import { loadPhoto, savePhoto } from "@/domain/photos";
import { missTurn } from "@/domain/turns";
import { diskStorage } from "@/providers/storage";
import { addChore, claimBounty, db, makeHouse, markDone, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z"); // Wed noon Toronto; garbage is due Thu 21:00
const LATE = new Date("2026-11-13T02:00:01Z"); // one second past the deadline
const NEXT_WEEK = new Date("2026-11-18T17:00:00Z");
const storage = diskStorage(mkdtempSync(path.join(tmpdir(), "housepot-test-")));
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

let house: TestHouse;
let choreId: string;
let a: string;
let b: string;
let c: string;

beforeEach(async () => {
  await resetDb();
  house = await makeHouse(3);
  [a, b, c] = house.members.map((m) => m.memberId);
  const chore = await addChore(db, {
    houseId: house.houseId,
    memberId: a,
    name: "Garbage",
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    now: NOW,
  });
  if (!chore.ok) throw new Error(chore.error);
  choreId = chore.choreId;
  await ensureTurns(db, house.houseId, NOW);
});

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

const waitingTurn = async () =>
  (await db.query("select id, assignee_member_id from turns where status = 'assigned'")).rows[0];
const turnRow = async (id: string) => (await db.query("select * from turns where id = $1", [id])).rows[0];
const balances = async () => Promise.all([a, b, c].map((m) => memberBalance(db, m)));

test("done on time with a photo moves no money", async () => {
  const turn = await waitingTurn();
  const photoId = await photo(a);
  expect(await markDone(db, { turnId: turn.id, memberId: a, photoId, now: NOW })).toEqual({
    ok: true,
    payoutCents: 0,
  });
  expect(await turnRow(turn.id)).toMatchObject({
    status: "done",
    completed_by_member_id: a,
    photo_id: photoId,
    payout_cents: 0,
  });
  expect(await balances()).toEqual([2000, 2000, 2000]);
});

test("done exactly at the deadline still counts", async () => {
  const turn = await waitingTurn();
  const r = await markDone(db, {
    turnId: turn.id,
    memberId: a,
    photoId: await photo(a),
    now: new Date("2026-11-13T02:00:00Z"),
  });
  expect(r.ok).toBe(true);
});

test("done after the deadline is refused", async () => {
  const turn = await waitingTurn();
  const r = await markDone(db, { turnId: turn.id, memberId: a, photoId: await photo(a), now: LATE });
  expect(r).toEqual({ ok: false, error: "The deadline has passed." });
  expect((await turnRow(turn.id)).status).toBe("assigned");
});

test("only the person whose turn it is can mark it done", async () => {
  const turn = await waitingTurn();
  const r = await markDone(db, { turnId: turn.id, memberId: b, photoId: await photo(b), now: NOW });
  expect(r).toEqual({ ok: false, error: "It is not your turn." });
});

test("done needs a photo from this house", async () => {
  const turn = await waitingTurn();
  const missing = await markDone(db, {
    turnId: turn.id,
    memberId: a,
    photoId: "00000000-0000-0000-0000-000000000000",
    now: NOW,
  });
  expect(missing).toEqual({ ok: false, error: "Add a photo of the finished chore." });

  const other = await makeHouse(1);
  const foreign = await photo(other.members[0].memberId, other.houseId);
  const r = await markDone(db, { turnId: turn.id, memberId: a, photoId: foreign, now: NOW });
  expect(r).toEqual({ ok: false, error: "Add a photo of the finished chore." });
});

test("there is no paid skip: a chore only costs its worth when it expires", async () => {
  const turns = await import("@/domain/turns");
  expect("payToSkip" in turns).toBe(false);
  const turn = await waitingTurn();
  expect(await missTurn(db, { turnId: turn.id, now: NOW })).toEqual({
    ok: false,
    error: "The deadline has not passed yet.",
  });
  expect(await balances()).toEqual([2000, 2000, 2000]);
});

test("a miss charges the chore's worth even when the balance is empty", async () => {
  await transfer(db, {
    houseId: house.houseId,
    from: { memberId: a },
    to: "external",
    amountCents: 2000,
    kind: "cashout_manual",
  });
  const turn = await waitingTurn();
  expect(await missTurn(db, { turnId: turn.id, now: LATE })).toEqual({ ok: true });
  expect(await memberBalance(db, a)).toBe(-500);
  expect(await choreBounty(db, choreId)).toBe(500);
  expect(await turnRow(turn.id)).toMatchObject({ status: "open", opened_reason: "miss" });
});

test("a turn cannot be missed before its deadline, and is charged once however often it is tried", async () => {
  const turn = await waitingTurn();
  expect((await missTurn(db, { turnId: turn.id, now: NOW })).ok).toBe(false);
  expect(await memberBalance(db, a)).toBe(2000);

  await missTurn(db, { turnId: turn.id, now: LATE });
  expect((await missTurn(db, { turnId: turn.id, now: LATE })).ok).toBe(false);
  await Promise.all([
    missTurn(db, { turnId: turn.id, now: LATE }),
    missTurn(db, { turnId: turn.id, now: LATE }),
  ]);
  expect(await memberBalance(db, a)).toBe(1500);
});

test("you cannot claim back a chore that expired on you: being late costs its worth", async () => {
  const turn = await waitingTurn();
  await missTurn(db, { turnId: turn.id, now: LATE });
  const r = await claimBounty(db, { turnId: turn.id, memberId: a, photoId: await photo(a), now: LATE });
  expect(r).toEqual({ ok: false, error: "This expired on you, so the money goes to whoever else does it." });
  expect(await balances()).toEqual([1500, 2000, 2000]);
  expect(await choreBounty(db, choreId)).toBe(500);
});

test("a housemate who does the missed chore is paid the bounty", async () => {
  const turn = await waitingTurn();
  await missTurn(db, { turnId: turn.id, now: LATE });
  const photoId = await photo(b);
  const r = await claimBounty(db, { turnId: turn.id, memberId: b, photoId, now: LATE });
  expect(r).toEqual({ ok: true, payoutCents: 500 });
  expect(await balances()).toEqual([1500, 2500, 2000]);
  expect(await choreBounty(db, choreId)).toBe(0);
  expect(await turnRow(turn.id)).toMatchObject({
    status: "claimed",
    completed_by_member_id: b,
    photo_id: photoId,
    payout_cents: 500,
  });
});

test("claiming needs a photo, and a turn that is not open cannot be claimed", async () => {
  const turn = await waitingTurn();
  const early = await claimBounty(db, { turnId: turn.id, memberId: b, photoId: await photo(b), now: NOW });
  expect(early).toEqual({ ok: false, error: "This chore is not open to claim." });

  await missTurn(db, { turnId: turn.id, now: LATE });
  const noPhoto = await claimBounty(db, {
    turnId: turn.id,
    memberId: b,
    photoId: "00000000-0000-0000-0000-000000000000",
    now: LATE,
  });
  expect(noPhoto).toEqual({ ok: false, error: "Add a photo of the finished chore." });
});

test("only paid-up housemates of this house can claim", async () => {
  const turn = await waitingTurn();
  await missTurn(db, { turnId: turn.id, now: LATE });
  const other = await makeHouse(1);
  const outsider = other.members[0].memberId;
  const r = await claimBounty(db, {
    turnId: turn.id,
    memberId: outsider,
    photoId: await photo(outsider, other.houseId),
    now: LATE,
  });
  expect(r.ok).toBe(false);

  await db.query("update members set status = 'pending' where id = $1", [c]);
  const pending = await claimBounty(db, { turnId: turn.id, memberId: c, photoId: await photo(c), now: LATE });
  expect(pending.ok).toBe(false);
  expect(await choreBounty(db, choreId)).toBe(500);
});

test("two housemates claiming at the same moment: exactly one is paid", async () => {
  const turn = await waitingTurn();
  await missTurn(db, { turnId: turn.id, now: LATE });
  const [pb, pc] = [await photo(b), await photo(c)];
  const results = await Promise.all([
    claimBounty(db, { turnId: turn.id, memberId: b, photoId: pb, now: LATE }),
    claimBounty(db, { turnId: turn.id, memberId: c, photoId: pc, now: LATE }),
  ]);
  expect(results.filter((r) => r.ok)).toHaveLength(1);
  // The loser either finds the first proof still being voted on, or the chore already claimed.
  const loser = results.find((r) => !r.ok);
  expect(loser?.ok === false && loser.error).toMatch(/already sent proof|not open to claim/);
  const [, balB, balC] = await balances();
  expect(balB + balC).toBe(4500);
  expect(await choreBounty(db, choreId)).toBe(0);
});

test("an unclaimed bounty goes to the next person when they do their turn on time", async () => {
  const first = await waitingTurn();
  await missTurn(db, { turnId: first.id, now: LATE });
  await ensureTurns(db, house.houseId, LATE);
  const second = await waitingTurn();
  expect(second.assignee_member_id).toBe(b);

  const r = await markDone(db, { turnId: second.id, memberId: b, photoId: await photo(b), now: NEXT_WEEK });
  expect(r).toEqual({ ok: true, payoutCents: 500 });
  expect(await balances()).toEqual([1500, 2500, 2000]);
  expect((await turnRow(first.id)).status).toBe("rolled");
  expect((await turnRow(second.id)).payout_cents).toBe(500);
});

test("a second miss stacks the bounty, and only the newest open turn can be claimed", async () => {
  const first = await waitingTurn();
  await missTurn(db, { turnId: first.id, now: LATE });
  await ensureTurns(db, house.houseId, LATE);
  const second = await waitingTurn();
  await missTurn(db, { turnId: second.id, now: new Date("2026-11-20T02:00:01Z") });

  expect((await turnRow(first.id)).status).toBe("rolled");
  expect(await choreBounty(db, choreId)).toBe(1000);
  const stale = await claimBounty(db, {
    turnId: first.id,
    memberId: c,
    photoId: await photo(c),
    now: NEXT_WEEK,
  });
  expect(stale.ok).toBe(false);
  const r = await claimBounty(db, {
    turnId: second.id,
    memberId: c,
    photoId: await photo(c),
    now: new Date("2026-11-20T03:00:00Z"),
  });
  expect(r).toEqual({ ok: true, payoutCents: 1000 });
  expect(await balances()).toEqual([1500, 1500, 3000]);
});

test("an open bounty can still be claimed after the next turn has been handed out", async () => {
  const first = await waitingTurn();
  await missTurn(db, { turnId: first.id, now: LATE });
  await ensureTurns(db, house.houseId, LATE);
  const r = await claimBounty(db, { turnId: first.id, memberId: c, photoId: await photo(c), now: LATE });
  expect(r).toEqual({ ok: true, payoutCents: 500 });
});

test("every outcome is written to the activity feed", async () => {
  const first = await waitingTurn();
  await missTurn(db, { turnId: first.id, now: LATE });
  await claimBounty(db, { turnId: first.id, memberId: b, photoId: await photo(b), now: LATE });
  await ensureTurns(db, house.houseId, LATE);
  const second = await waitingTurn();
  // The second turn is next week's, so it is done next week: a turn opens two days before its deadline.
  await markDone(db, { turnId: second.id, memberId: b, photoId: await photo(b), now: NEXT_WEEK });
  await ensureTurns(db, house.houseId, NEXT_WEEK);
  const third = await waitingTurn();
  await missTurn(db, { turnId: third.id, now: new Date("2026-11-27T02:00:01Z") });

  const { rows } = await db.query(
    "select kind, data from activity where kind in ('skipped','claimed','done','missed')",
  );
  expect(rows.map((r) => r.kind).sort()).toEqual(["claimed", "done", "missed", "missed"]);
  for (const r of rows) expect(r.data).toMatchObject({ choreName: "Garbage" });
});

test.each([
  ["application/pdf", JPEG, /photo/i],
  ["image/jpeg", Buffer.alloc(0), /photo/i],
  ["image/jpeg", Buffer.alloc(8 * 1024 * 1024 + 1), /8 MB/],
])("a %s upload of that size is refused", async (contentType, bytes, message) => {
  const r = await savePhoto(db, storage, {
    houseId: house.houseId,
    memberId: a,
    bytes,
    contentType,
    now: NOW,
  });
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error).toMatch(message);
});

test.each(["image/jpeg", "image/png", "image/webp", "image/heic"])(
  "a %s photo is stored and read back",
  async (contentType) => {
    const r = await savePhoto(db, storage, {
      houseId: house.houseId,
      memberId: a,
      bytes: JPEG,
      contentType,
      now: NOW,
    });
    if (!r.ok) throw new Error(r.error);
    const loaded = await loadPhoto(db, storage, r.photoId);
    expect(loaded).toMatchObject({ houseId: house.houseId, contentType });
    expect(loaded?.bytes.equals(JPEG)).toBe(true);
  },
);

test("a photo from someone outside the house is refused", async () => {
  const other = await makeHouse(1);
  const r = await savePhoto(db, storage, {
    houseId: house.houseId,
    memberId: other.members[0].memberId,
    bytes: JPEG,
    contentType: "image/jpeg",
    now: NOW,
  });
  expect(r.ok).toBe(false);
});

// Found by a tester: next week's turn could be marked done today, and it collected the money
// waiting on tonight's still-open chore with the same photo.
test("a turn cannot be marked done more than two days before its deadline", async () => {
  const turn = (await db.query("select id, due_at from turns where status = 'assigned'")).rows[0];
  const threeDaysEarly = new Date(turn.due_at.getTime() - 3 * 24 * 60 * 60_000);
  const early = await markDone(db, {
    turnId: turn.id,
    memberId: a,
    photoId: await photo(a),
    now: threeDaysEarly,
  });
  expect(early).toEqual({
    ok: false,
    error: "This is not due yet. You can mark it done from two days before the deadline.",
  });
  expect((await db.query("select status from turns where id = $1", [turn.id])).rows[0].status).toBe(
    "assigned",
  );

  const dayBefore = new Date(turn.due_at.getTime() - 24 * 60 * 60_000);
  expect(
    (await markDone(db, { turnId: turn.id, memberId: a, photoId: await photo(a), now: dayBefore })).ok,
  ).toBe(true);
});
