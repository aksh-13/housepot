import { beforeEach, expect, test } from "vitest";
import { activeMembers, createHouse, joinHouse } from "@/domain/houses";
import { memberBalance, transfer } from "@/domain/ledger";
import { amountDue, applyPaymentEvent, startCheckout } from "@/domain/payments";
import { fakePayments, type PaymentEvent } from "@/providers/payments";
import { db, makeHouse, makeUser, resetDb } from "./helpers";

const NOW = new Date("2026-11-14T15:00:00Z");

beforeEach(resetDb);

async function pendingMember() {
  const userId = await makeUser("Ana");
  const h = await createHouse(db, { userId, houseName: "12 Elm", now: NOW });
  if (!h.ok) throw new Error(h.error);
  return h;
}

const depositEvent = (memberId: string, providerRef = "pay_1"): PaymentEvent => ({
  type: "payment_succeeded",
  providerRef,
  memberId,
  amountCents: 2000,
  feeCents: 91,
  purpose: "deposit",
});

test("a new member owes the full deposit; a member who lost $5 owes $5", async () => {
  const h = await pendingMember();
  expect(await amountDue(db, h.memberId)).toBe(2000);
  await applyPaymentEvent(db, depositEvent(h.memberId), NOW);
  expect(await amountDue(db, h.memberId)).toBe(0);
  const chore = await db.query(
    "insert into chores (house_id, name, schedule_kind, weekday, deadline_time, skip_price_cents) values ($1, 'G', 'weekly', 4, '21:00', 500) returning id",
    [h.houseId],
  );
  await transfer(db, {
    houseId: h.houseId,
    from: { memberId: h.memberId },
    to: { choreId: chore.rows[0].id },
    amountCents: 500,
    kind: "skip",
  });
  expect(await amountDue(db, h.memberId)).toBe(500);
});

test("a successful deposit credits the balance and makes the member active", async () => {
  const h = await pendingMember();
  await applyPaymentEvent(db, { ...depositEvent(h.memberId), customerRef: "cus_1" }, NOW);

  expect(await memberBalance(db, h.memberId)).toBe(2000);
  const members = await activeMembers(db, h.houseId);
  expect(members.map((m) => m.id)).toEqual([h.memberId]);
  expect(members[0].customerRef).toBe("cus_1");
});

test("the same payment delivered twice is credited once", async () => {
  const h = await pendingMember();
  await applyPaymentEvent(db, depositEvent(h.memberId), NOW);
  await applyPaymentEvent(db, depositEvent(h.memberId), NOW);

  expect(await memberBalance(db, h.memberId)).toBe(2000);
  const { rows } = await db.query("select amount_cents, fee_cents, purpose from payments");
  expect(rows).toEqual([{ amount_cents: 2000, fee_cents: 91, purpose: "deposit" }]);
});

test("the same payment delivered twice at the same moment is credited once", async () => {
  const h = await pendingMember();
  await Promise.all([
    applyPaymentEvent(db, depositEvent(h.memberId), NOW),
    applyPaymentEvent(db, depositEvent(h.memberId), NOW),
  ]);
  expect(await memberBalance(db, h.memberId)).toBe(2000);
});

test("a payment for a member that does not exist is ignored", async () => {
  await applyPaymentEvent(db, depositEvent("00000000-0000-0000-0000-000000000000"), NOW);
  expect((await db.query("select count(*)::int as n from payments")).rows[0].n).toBe(0);
});

test("a later payment does not wipe a saved card when it carries none", async () => {
  const h = await pendingMember();
  await applyPaymentEvent(db, { ...depositEvent(h.memberId), customerRef: "cus_1" }, NOW);
  await applyPaymentEvent(db, { ...depositEvent(h.memberId, "pay_2"), purpose: "topup" }, NOW);
  expect((await activeMembers(db, h.houseId))[0].customerRef).toBe("cus_1");
});

test("checkout through the fake provider carries an event that the webhook reads back", async () => {
  const h = await pendingMember();
  const payments = fakePayments();
  const started = await startCheckout(db, payments, {
    memberId: h.memberId,
    saveCard: true,
    baseUrl: "http://localhost:3000",
  });
  if ("error" in started) throw new Error(started.error);
  const url = new URL(started.url, "http://localhost:3000");
  expect(url.pathname).toBe("/dev/fake-checkout");

  const payload = JSON.parse(Buffer.from(url.searchParams.get("p")!, "base64url").toString());
  expect(payload.successUrl).toBe("http://localhost:3000/house?paid=1");
  const event = await payments.parseWebhook(JSON.stringify(payload.event), "fake");
  expect(event).toMatchObject({
    type: "payment_succeeded",
    memberId: h.memberId,
    amountCents: 2000,
    feeCents: 91,
    purpose: "deposit",
  });
  expect(event?.customerRef).toBeTruthy();

  await applyPaymentEvent(db, event!, NOW);
  expect(await memberBalance(db, h.memberId)).toBe(2000);
});

test("the fake webhook rejects a body without the fake signature or with a broken shape", async () => {
  const payments = fakePayments();
  const body = JSON.stringify(depositEvent("m"));
  expect(await payments.parseWebhook(body, null)).toBeNull();
  expect(await payments.parseWebhook("{not json", "fake")).toBeNull();
  expect(await payments.parseWebhook(JSON.stringify({ type: "payment_succeeded" }), "fake")).toBeNull();
  expect(
    await payments.parseWebhook(JSON.stringify({ ...depositEvent("m"), amountCents: -5 }), "fake"),
  ).toBeNull();
});

test("there is nothing to check out when the member is at or above the deposit", async () => {
  const h = await pendingMember();
  await applyPaymentEvent(db, depositEvent(h.memberId), NOW);
  const r = await startCheckout(db, fakePayments(), {
    memberId: h.memberId,
    saveCard: false,
    baseUrl: "http://x",
  });
  expect(r).toEqual({ error: "You are fully paid up." });
});

test("an active member below the deposit checks out a top-up for the difference", async () => {
  const { houseId, members } = await makeHouse(2);
  const chore = await db.query(
    "insert into chores (house_id, name, schedule_kind, weekday, deadline_time, skip_price_cents) values ($1, 'G', 'weekly', 4, '21:00', 500) returning id",
    [houseId],
  );
  await transfer(db, {
    houseId,
    from: { memberId: members[0].memberId },
    to: { choreId: chore.rows[0].id },
    amountCents: 700,
    kind: "miss",
  });
  const started = await startCheckout(db, fakePayments(), {
    memberId: members[0].memberId,
    saveCard: false,
    baseUrl: "http://x",
  });
  if ("error" in started) throw new Error(started.error);
  const payload = JSON.parse(
    Buffer.from(new URL(started.url, "http://x").searchParams.get("p")!, "base64url").toString(),
  );
  expect(payload.event).toMatchObject({ amountCents: 700, purpose: "topup" });
});

test("makeHouse gives active members with full deposits, in rotation order", async () => {
  const { houseId, members } = await makeHouse(3);
  expect((await activeMembers(db, houseId)).map((m) => m.id)).toEqual(members.map((m) => m.memberId));
  for (const m of members) expect(await memberBalance(db, m.memberId)).toBe(2000);
  // joinHouse is what makeHouse uses, so a fourth person can still join by code.
  const { rows } = await db.query("select invite_code from houses where id = $1", [houseId]);
  const late = await joinHouse(db, {
    userId: await makeUser("Late"),
    inviteCode: rows[0].invite_code,
    now: NOW,
  });
  expect(late.ok).toBe(true);
});
