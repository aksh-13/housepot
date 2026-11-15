import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, test } from "vitest";

process.env.INBOUND_EMAIL_SECRET = "test-inbound-secret";

import { POST as emailWebhook } from "@/app/api/webhooks/email/route";
import { createChore, ensureTurns } from "@/domain/chores";
import { fakeReceivedEmail, fakeRequestEmail } from "@/domain/fakeInterac";
import { forwardingAddress, handleInboundEmail, type InboundEmail } from "@/domain/inbound";
import { allowedRequestUrl, isFromInterac, parseInteracEmail } from "@/domain/interac";
import { savePhoto } from "@/domain/photos";
import { type CreatedDebt, settleUpHouse } from "@/domain/settleup";
import { claimBounty, payToSkip } from "@/domain/turns";
import { diskStorage } from "@/providers/storage";
import { db, makeHouse, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z");
const DEC_1 = new Date("2026-12-01T14:00:00Z");
const storage = diskStorage(mkdtempSync(path.join(tmpdir(), "housepot-inbound-")));
const REQUEST_URL = "https://etransfer.interac.ca/reqPayment/eml/CA1MRqAbCdEf";

let house: TestHouse;
let debt: CreatedDebt;
let anaAddress: string;
let benAddress: string;

const debtRow = async () => (await db.query("select * from debts where id = $1", [debt.id])).rows[0];

beforeEach(async () => {
  await resetDb();
  house = await makeHouse(3, { moneyMode: "etransfer" });
  const [a, b] = house.members.map((m) => m.memberId);
  const chore = await createChore(db, {
    houseId: house.houseId,
    memberId: a,
    name: "Garbage",
    schedule: { kind: "weekly", weekday: 4 },
    deadlineTime: "21:00",
    now: NOW,
  });
  if (!chore.ok) throw new Error(chore.error);
  await ensureTurns(db, house.houseId, NOW);
  const turn = (await db.query("select id from turns where status = 'assigned'")).rows[0];
  await payToSkip(db, { turnId: turn.id, memberId: a, now: NOW });
  const photo = await savePhoto(db, storage, {
    houseId: house.houseId,
    memberId: b,
    bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1]),
    contentType: "image/jpeg",
    now: NOW,
  });
  if (!photo.ok) throw new Error(photo.error);
  await claimBounty(db, { turnId: turn.id, memberId: b, photoId: photo.photoId, now: NOW });
  [debt] = await settleUpHouse(db, { houseId: house.houseId, now: DEC_1, reason: "scheduled" });
  // Ana (A) owes Ben (B) $5.
  anaAddress = await forwardingAddress(db, house.members[0].userId);
  benAddress = await forwardingAddress(db, house.members[1].userId);
});

const benGetsPaid = (over: Partial<InboundEmail> = {}, message = `chores ${debt.code}`) => ({
  ...fakeReceivedEmail({ to: benAddress, senderName: "ANA SMITH", amountCents: 500, message }),
  ...over,
});

describe("reading Interac emails", () => {
  test("a 'sent you money' email gives the amount, the sender and the code", () => {
    const parsed = parseInteracEmail(
      fakeReceivedEmail({ to: "x", senderName: "ANA SMITH", amountCents: 1250, message: "thanks hp-7k3q" }),
    );
    expect(parsed).toEqual({
      kind: "received",
      amountCents: 1250,
      senderName: "ANA SMITH",
      codes: ["HP-7K3Q"],
    });
  });

  test("a money request email gives the amount, the requester and the Interac link", () => {
    const parsed = parseInteracEmail(
      fakeRequestEmail({
        to: "x",
        requesterName: "Ben",
        amountCents: 500,
        message: "HP-ABCD",
        url: REQUEST_URL,
      }),
    );
    expect(parsed).toEqual({
      kind: "request",
      amountCents: 500,
      requesterName: "Ben",
      codes: ["HP-ABCD"],
      url: REQUEST_URL,
    });
  });

  test("amounts with thousands separators and no cents are read correctly", () => {
    const parsed = parseInteracEmail({ subject: "X sent you money", text: "X sent you $1,200 (CAD)" });
    expect(parsed?.amountCents).toBe(120000);
  });

  test("an email with no amount, or about something else, is not understood", () => {
    expect(parseInteracEmail({ subject: "Your statement is ready", text: "Log in to view" })).toBeNull();
    expect(parseInteracEmail({ subject: "Sale!", text: "Everything $5 off" })).toBeNull();
  });

  test("only Interac's own addresses count as Interac", () => {
    expect(isFromInterac("Interac e-Transfer <notify@payments.interac.ca>")).toBe(true);
    expect(isFromInterac("notify@interac.ca")).toBe(true);
    expect(isFromInterac("notify@interac.ca.evil.com")).toBe(false);
    expect(isFromInterac("interac@gmail.com")).toBe(false);
  });

  test("a request link is only kept when it points at Interac", () => {
    expect(allowedRequestUrl(REQUEST_URL)).toBe(true);
    expect(allowedRequestUrl("http://etransfer.interac.ca/x")).toBe(false);
    expect(allowedRequestUrl("https://etransfer.interac.ca.evil.com/x")).toBe(false);
    expect(allowedRequestUrl("https://evil.com/?u=etransfer.interac.ca")).toBe(false);
    expect(allowedRequestUrl("http://localhost:3000/dev/fake-interac/1", ["localhost:3000"])).toBe(true);
  });
});

test("each person gets one private forwarding address that does not change", async () => {
  expect(anaAddress).toMatch(/^pay-[a-f0-9]{16}@pay\.housepot\.local$/);
  expect(await forwardingAddress(db, house.members[0].userId)).toBe(anaAddress);
  expect(benAddress).not.toBe(anaAddress);
});

test("Interac's email with the code marks the debt paid, with nobody tapping anything", async () => {
  const handled = await handleInboundEmail(db, benGetsPaid(), DEC_1);
  expect(handled).toMatchObject({ outcome: "paid", debtId: debt.id });
  expect(await debtRow()).toMatchObject({ status: "paid", paid_via: "email" });
});

test("the same email delivered twice is handled once", async () => {
  const email = benGetsPaid();
  await handleInboundEmail(db, email, DEC_1);
  expect(await handleInboundEmail(db, email, DEC_1)).toEqual({ outcome: "duplicate" });
});

test("an email that failed its signature check is ignored", async () => {
  const handled = await handleInboundEmail(db, benGetsPaid({ authenticated: false }), DEC_1);
  expect(handled.outcome).toBe("not_authenticated");
  expect((await debtRow()).status).toBe("owed");
});

test("an email that is not from Interac is ignored even when signed", async () => {
  const handled = await handleInboundEmail(db, benGetsPaid({ from: "Ana <ana@gmail.com>" }), DEC_1);
  expect(handled.outcome).toBe("not_interac");
  expect((await debtRow()).status).toBe("owed");
});

test("the payer's own forwarded email cannot mark their debt paid", async () => {
  // Interac's "you got money" email only counts at the receiver's address.
  const handled = await handleInboundEmail(db, benGetsPaid({ to: anaAddress }), DEC_1);
  expect(handled.outcome).toBe("no_match");
  expect((await debtRow()).status).toBe("owed");
});

test("less money than owed does not clear the debt", async () => {
  const short = fakeReceivedEmail({
    to: benAddress,
    senderName: "ANA",
    amountCents: 300,
    message: debt.code,
  });
  expect((await handleInboundEmail(db, short, DEC_1)).outcome).toBe("amount_short");
  expect((await debtRow()).status).toBe("owed");
});

test("without a code, the exact amount from the right person still matches", async () => {
  const handled = await handleInboundEmail(db, benGetsPaid({}, "for chores"), DEC_1);
  expect(handled.outcome).toBe("paid");
});

test("without a code, an e-Transfer from someone else for the same amount does not match", async () => {
  const other = fakeReceivedEmail({
    to: benAddress,
    senderName: "ZOE PARK",
    amountCents: 500,
    message: "pizza",
  });
  expect((await handleInboundEmail(db, other, DEC_1)).outcome).toBe("no_match");
  expect((await debtRow()).status).toBe("owed");
});

test("an email to an address nobody has is recorded and ignored", async () => {
  const handled = await handleInboundEmail(
    db,
    benGetsPaid({ to: "pay-0000000000000000@pay.housepot.local" }),
    DEC_1,
  );
  expect(handled.outcome).toBe("unknown_address");
});

test("a money request email saves the Interac link for the payer's Pay button", async () => {
  const request = fakeRequestEmail({
    to: anaAddress,
    requesterName: "Ben",
    amountCents: 500,
    message: debt.code,
    url: REQUEST_URL,
  });
  expect((await handleInboundEmail(db, request, DEC_1)).outcome).toBe("request_saved");
  expect((await debtRow()).request_url).toBe(REQUEST_URL);
});

test("a money request with a link that is not Interac's is not saved", async () => {
  const request = fakeRequestEmail({
    to: anaAddress,
    requesterName: "Ben",
    amountCents: 500,
    message: debt.code,
    url: "https://evil.example/pay",
  });
  expect((await handleInboundEmail(db, request, DEC_1)).outcome).toBe("request_without_link");
  expect((await debtRow()).request_url).toBeNull();
});

test("Gmail's forwarding confirmation code is kept so the app can show it", async () => {
  await handleInboundEmail(
    db,
    {
      messageId: "<gmail-1@google.com>",
      to: benAddress,
      from: "Gmail Team <forwarding-noreply@google.com>",
      subject: "(#123456789) Gmail Forwarding Confirmation - Receive Mail from ben@gmail.com",
      text: "Confirmation code: 123456789\nTo allow ben@gmail.com to automatically forward mail...",
      authenticated: true,
    },
    DEC_1,
  );
  const { rows } = await db.query("select forwarding_code from users where id = $1", [
    house.members[1].userId,
  ]);
  expect(rows[0].forwarding_code).toBe("123456789");
});

describe("the email webhook", () => {
  const post = (body: unknown, secret = "test-inbound-secret") =>
    emailWebhook(
      new Request("http://x/api/webhooks/email", {
        method: "POST",
        headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );

  test("refuses callers without the secret", async () => {
    expect((await post(benGetsPaid(), "wrong")).status).toBe(401);
    expect((await debtRow()).status).toBe("owed");
  });

  test("refuses a body with missing fields", async () => {
    expect((await post({ to: benAddress })).status).toBe(400);
  });

  test("marks the debt paid and texts both people", async () => {
    const res = await post(benGetsPaid());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "paid" });
    expect((await debtRow()).status).toBe("paid");
    const { rows } = await db.query(
      "select to_phone, body from sms_outbox where body like '%square%' or body like '%arrived%'",
    );
    expect(rows.map((r) => r.to_phone).sort()).toEqual(
      [house.members[0].phone, house.members[1].phone].sort(),
    );
  });
});
