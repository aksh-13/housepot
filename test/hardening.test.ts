// Tests for problems found in the whole-project review. Each one failed before its fix.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import { POST as webhook } from "@/app/api/webhooks/payments/route";
import { submitClaim, submitDone, voteOnSubmission } from "@/domain/approvals";
import { requestCode } from "@/domain/auth";
import { createChore, ensureTurns, updateChore } from "@/domain/chores";
import { joinHouse, setPaused } from "@/domain/houses";
import { choreBounty, memberBalance, transfer } from "@/domain/ledger";
import { amountDue } from "@/domain/payments";
import { savePhoto } from "@/domain/photos";
import { cashOutMember, leaveHouse, pendingManualPayouts, settleHouse } from "@/domain/settlement";
import { missTurn } from "@/domain/turns";
import { getProviders } from "@/providers";
import { fakePayments } from "@/providers/payments";
import { fakeSms } from "@/providers/sms";
import { diskStorage } from "@/providers/storage";
import { claimBounty, db, makeHouse, markDone, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z"); // Wed noon Toronto; garbage due Thu 21:00
const LATE = new Date("2026-11-13T02:00:01Z");
const HOUR = 3600_000;
const after = (base: Date, hours: number) => new Date(base.getTime() + hours * HOUR);
const storage = diskStorage(mkdtempSync(path.join(tmpdir(), "housepot-test-")));

beforeEach(resetDb);

async function houseWithGarbage(size: number, opts?: { active?: number }) {
  const house = await makeHouse(size, opts);
  const ids = house.members.map((m) => m.memberId);
  const chore = await createChore(db, {
    houseId: house.houseId,
    memberId: ids[0],
    name: "Garbage",
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    now: NOW,
  });
  if (!chore.ok) throw new Error(chore.error);
  await ensureTurns(db, house.houseId, NOW);
  return { house, ids, choreId: chore.choreId };
}

async function photo(house: TestHouse, memberId: string) {
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

const waitingTurnId = async (houseId: string) =>
  (await db.query("select id from turns where status = 'assigned' and house_id = $1", [houseId])).rows[0].id;

/** Moves money between two housemates the way a skip and a payout would. */
async function shift(houseId: string, choreId: string, from: string, to: string, amountCents: number) {
  await transfer(db, { houseId, from: { memberId: from }, to: { choreId }, amountCents, kind: "skip" });
  await transfer(db, {
    houseId,
    from: { choreId },
    to: { memberId: to },
    amountCents,
    kind: "bounty_payout",
  });
}

// ── A bounty must be paid exactly once ────────────────────────────────────────

test("the next person finishing on time while someone claims the old turn: the bounty is paid once", async () => {
  for (let round = 0; round < 8; round++) {
    const { house, ids, choreId } = await houseWithGarbage(3);
    const first = await waitingTurnId(house.houseId);
    await missTurn(db, { turnId: first, now: LATE });
    await ensureTurns(db, house.houseId, LATE);
    const second = await waitingTurnId(house.houseId);
    const [pb, pc] = [await photo(house, ids[1]), await photo(house, ids[2])];

    await Promise.all([
      markDone(db, { turnId: second, memberId: ids[1], photoId: pb, now: after(LATE, 1) }),
      claimBounty(db, { turnId: first, memberId: ids[2], photoId: pc, now: after(LATE, 1) }),
    ]);

    expect(await choreBounty(db, choreId)).toBe(0);
    expect((await memberBalance(db, ids[1])) + (await memberBalance(db, ids[2]))).toBe(4500);
  }
});

test("settling the house while someone claims a bounty never pays out more than was paid in", async () => {
  for (let round = 0; round < 6; round++) {
    const { house, ids } = await houseWithGarbage(3);
    const first = await waitingTurnId(house.houseId);
    await missTurn(db, { turnId: first, now: LATE });
    const payments = fakePayments();
    const pc = await photo(house, ids[2]);

    await Promise.all([
      settleHouse(db, payments, { houseId: house.houseId, now: after(LATE, 1) }),
      claimBounty(db, { turnId: first, memberId: ids[2], photoId: pc, now: after(LATE, 1) }),
    ]);

    const refunded = payments.refunds.reduce((sum, r) => sum + r.amountCents, 0);
    const manual = await db.query(
      "select coalesce(sum(amount_cents), 0)::int as n from manual_payouts where house_id = $1",
      [house.houseId],
    );
    const stillHeld = await db.query(
      "select coalesce(sum(amount_cents), 0)::int as n from ledger_entries where account_type <> 'external' and house_id = $1",
      [house.houseId],
    );
    expect(refunded + manual.rows[0].n + stillHeld.rows[0].n).toBe(6000);
  }
});

// ── Refunds whose outcome is unknown ──────────────────────────────────────────

test("when the card processor does not answer, the cash-out stops instead of also paying by hand", async () => {
  const { house, ids } = await houseWithGarbage(1);
  await db.query("update payments set provider_ref = 'unknown_1' where member_id = $1", [ids[0]]);
  const payments = fakePayments();

  await expect(cashOutMember(db, payments, { memberId: ids[0], now: NOW })).rejects.toThrow(/refund/i);

  expect(await memberBalance(db, ids[0])).toBe(2000);
  expect(await pendingManualPayouts(db)).toEqual([]);
  const attempts = await db.query("select amount_cents, status from refund_attempts");
  expect(attempts.rows).toEqual([{ amount_cents: 2000, status: "pending" }]);
  expect(house.houseId).toBeTruthy();
});

test("a refund that went out before a crash is recognised on retry, not sent again or paid by hand", async () => {
  const { house, ids, choreId } = await houseWithGarbage(2);
  const payments = fakePayments();

  // The refund reaches the card processor, then the surrounding work fails and is rolled back.
  await expect(
    db.tx(async (t) => {
      await cashOutMember(t, payments, { memberId: ids[0], now: NOW });
      throw new Error("pod killed");
    }),
  ).rejects.toThrow("pod killed");
  expect(payments.refunds).toHaveLength(1);
  expect(await memberBalance(db, ids[0])).toBe(2000); // rolled back

  // Before the retry, the balance changes.
  await shift(house.houseId, choreId, ids[0], ids[1], 500);
  const retry = await cashOutMember(db, payments, { memberId: ids[0], now: after(NOW, 1) });

  // Same request as before (same key, same amount), so the processor does not refund twice.
  expect(payments.refunds).toHaveLength(2);
  expect(payments.refunds[1]).toEqual(payments.refunds[0]);
  expect(retry).toEqual({ refundedCents: 2000, manualCents: 0, writtenOffCents: 500 });
  expect(await pendingManualPayouts(db)).toEqual([]);
  expect(await memberBalance(db, ids[0])).toBe(0);
});

// ── Approval votes ────────────────────────────────────────────────────────────

test("a claim the house rejects leaves the chore open, and it can be claimed again", async () => {
  const { house, ids } = await houseWithGarbage(3);
  const turnId = await waitingTurnId(house.houseId);
  await missTurn(db, { turnId, now: LATE });
  const first = await submitClaim(db, {
    turnId,
    memberId: ids[1],
    photoIds: [await photo(house, ids[1])],
    now: LATE,
  });
  if (!first.ok) throw new Error(first.error);
  for (const voter of [ids[0], ids[2]]) {
    await voteOnSubmission(db, {
      submissionId: first.submissionId,
      memberId: voter,
      approve: false,
      now: after(LATE, 1),
    });
  }
  expect((await db.query("select status from turns where id = $1", [turnId])).rows[0].status).toBe("open");

  const again = await claimBounty(db, {
    turnId,
    memberId: ids[2],
    photoId: await photo(house, ids[2]),
    now: after(LATE, 2),
  });
  expect(again).toEqual({ ok: true, payoutCents: 500 });
});

// ── Leaving must not be a way out of a charge ─────────────────────────────────

test("you cannot leave while the house is still voting on proof you sent", async () => {
  const { house, ids } = await houseWithGarbage(3);
  const payments = fakePayments();
  const turnId = await waitingTurnId(house.houseId);
  const sent = await submitDone(db, {
    turnId,
    memberId: ids[0],
    photoIds: [await photo(house, ids[0])],
    now: NOW,
  });
  if (!sent.ok) throw new Error(sent.error);

  const tooSoon = await leaveHouse(db, payments, { memberId: ids[0], now: after(NOW, 1) });
  expect(tooSoon).toEqual({
    ok: false,
    error: "The house is still voting on a chore you sent proof for. You can leave once it is decided.",
  });
  expect(await memberBalance(db, ids[0])).toBe(2000);

  await voteOnSubmission(db, {
    submissionId: sent.submissionId,
    memberId: ids[1],
    approve: true,
    now: after(NOW, 2),
  });
  await voteOnSubmission(db, {
    submissionId: sent.submissionId,
    memberId: ids[2],
    approve: true,
    now: after(NOW, 2),
  });
  await db.query("update turns set status = 'cancelled' where status = 'assigned'");
  expect((await leaveHouse(db, payments, { memberId: ids[0], now: after(NOW, 3) })).ok).toBe(true);
});

test("leaving while it is your turn counts as letting it expire", async () => {
  const { house, ids, choreId } = await houseWithGarbage(3);
  const payments = fakePayments();
  const turnId = await waitingTurnId(house.houseId);

  expect((await leaveHouse(db, payments, { memberId: ids[0], now: NOW })).ok).toBe(true);

  expect(payments.refunds.map((r) => r.amountCents)).toEqual([1500]);
  expect(await choreBounty(db, choreId)).toBe(500);
  expect((await db.query("select status, opened_reason from turns where id = $1", [turnId])).rows[0]).toEqual(
    {
      status: "open",
      opened_reason: "miss",
    },
  );
});

test("a debt written off on leaving comes back if the same person rejoins", async () => {
  const { house, ids, choreId } = await houseWithGarbage(2);
  await db.query("update turns set status = 'cancelled'"); // no turn in play for this check
  const payments = fakePayments();
  await shift(house.houseId, choreId, ids[0], ids[1], 2500); // ids[0] at -500
  await leaveHouse(db, payments, { memberId: ids[0], now: NOW });

  const again = await joinHouse(db, {
    userId: house.members[0].userId,
    inviteCode: house.inviteCode,
    now: LATE,
  });
  if (!again.ok) throw new Error(again.error);

  expect(await memberBalance(db, again.memberId)).toBe(-500);
  expect(await amountDue(db, again.memberId)).toBe(2500);
});

// ── Only paid-up housemates run the house ─────────────────────────────────────

test("someone who has not paid in cannot pause the house or add, edit or remove chores", async () => {
  const { house, ids, choreId } = await houseWithGarbage(2, { active: 1 });
  const unpaid = ids[1];

  const paused = await setPaused(db, { houseId: house.houseId, memberId: unpaid, paused: true, now: NOW });
  expect(paused.ok).toBe(false);
  expect((await db.query("select paused from houses where id = $1", [house.houseId])).rows[0].paused).toBe(
    false,
  );

  const added = await createChore(db, {
    houseId: house.houseId,
    memberId: unpaid,
    name: "Dishes",
    schedule: { kind: "weekly", weekday: 1 },
    deadlineTime: "21:00",
    now: NOW,
  });
  expect(added.ok).toBe(false);
  expect((await updateChore(db, { choreId, memberId: unpaid, skipPriceCents: 5000, now: NOW })).ok).toBe(
    false,
  );
  expect((await updateChore(db, { choreId, memberId: unpaid, archived: true, now: NOW })).ok).toBe(false);
});

// ── Sign-in texts cannot be used to run up a bill ─────────────────────────────

test("a phone number gets at most five sign-in codes an hour", async () => {
  const sms = fakeSms(db);
  const phone = "+19055550100";
  for (let i = 0; i < 5; i++) {
    expect((await requestCode(db, sms, phone, new Date(NOW.getTime() + i * 31_000))).ok).toBe(true);
  }
  const sixth = await requestCode(db, sms, phone, new Date(NOW.getTime() + 5 * 31_000));
  expect(sixth.ok).toBe(false);
  expect(sixth.error).toMatch(/hour/);
  expect((await db.query("select count(*)::int as n from sms_outbox")).rows[0].n).toBe(5);

  expect((await requestCode(db, sms, phone, after(NOW, 1.1))).ok).toBe(true);
});

test("codes are only texted to Canadian and US numbers", async () => {
  const r = await requestCode(db, fakeSms(db), "+442079460958", NOW);
  expect(r.ok).toBe(false);
  expect(r.error).toMatch(/Canadian and US/);
  expect((await db.query("select count(*)::int as n from sms_outbox")).rows[0].n).toBe(0);
});

// ── Configuration and webhooks ────────────────────────────────────────────────

test("a mistyped provider name is an error, not a silent fall back to the fake one", () => {
  const before = process.env.PAYMENTS_PROVIDER;
  process.env.PAYMENTS_PROVIDER = "strpe";
  try {
    expect(() => getProviders()).toThrow(/PAYMENTS_PROVIDER/);
  } finally {
    if (before === undefined) delete process.env.PAYMENTS_PROVIDER;
    else process.env.PAYMENTS_PROVIDER = before;
  }
});

test("a genuine webhook about something other than a payment is acknowledged, so it is not retried", async () => {
  const res = await webhook(
    new Request("http://x/api/webhooks/payments", {
      method: "POST",
      body: JSON.stringify({ type: "customer.created" }),
      headers: { "x-fake-signature": "fake" },
    }),
  );
  expect(res.status).toBe(200);
  expect((await db.query("select count(*)::int as n from payments")).rows[0].n).toBe(0);
});
