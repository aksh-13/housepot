import { beforeEach, expect, test } from "vitest";
import { normalizePhone, requestCode, sessionUser, setUserName, verifyCode } from "@/domain/auth";
import { normalizeEmail } from "@/domain/houses";
import { fakeSms } from "@/providers/sms";
import { db, resetDb } from "./helpers";

const PHONE = "+19055550100";
const T0 = new Date("2026-11-14T15:00:00Z");
const plus = (ms: number) => new Date(T0.getTime() + ms);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

beforeEach(resetDb);

async function lastCode(): Promise<string> {
  const { rows } = await db.query("select body from sms_outbox order by id desc limit 1");
  return rows[0].body.match(/\b(\d{6})\b/)[1];
}

test.each([
  ["(905) 555-0100", "+19055550100"],
  ["905.555.0100", "+19055550100"],
  ["1 905 555 0100", "+19055550100"],
  ["+44 20 7946 0958", "+442079460958"],
])("normalizePhone(%s) is %s", (input, expected) => {
  expect(normalizePhone(input)).toBe(expected);
});

test.each(["abc", "", "12345", "+1"])("normalizePhone(%s) is null", (input) => {
  expect(normalizePhone(input)).toBeNull();
});

test("the texted code signs you in and creates your user once", async () => {
  const sms = fakeSms(db);
  expect((await requestCode(db, sms, PHONE, T0)).ok).toBe(true);
  const first = await verifyCode(db, PHONE, await lastCode(), plus(MIN));
  expect(first).not.toBeNull();

  await requestCode(db, sms, PHONE, plus(2 * MIN));
  const second = await verifyCode(db, PHONE, await lastCode(), plus(3 * MIN));
  expect(second?.userId).toBe(first?.userId);

  const user = await sessionUser(db, first!.sessionToken, plus(4 * MIN));
  expect(user).toMatchObject({ id: first!.userId, phone: PHONE, name: null });
});

test("a code cannot be used twice", async () => {
  await requestCode(db, fakeSms(db), PHONE, T0);
  const code = await lastCode();
  expect(await verifyCode(db, PHONE, code, plus(MIN))).not.toBeNull();
  expect(await verifyCode(db, PHONE, code, plus(2 * MIN))).toBeNull();
});

test("five wrong guesses burn the code", async () => {
  await requestCode(db, fakeSms(db), PHONE, T0);
  const code = await lastCode();
  const wrong = code === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) expect(await verifyCode(db, PHONE, wrong, plus(MIN))).toBeNull();
  expect(await verifyCode(db, PHONE, code, plus(MIN))).toBeNull();
});

test("a code stops working after ten minutes", async () => {
  await requestCode(db, fakeSms(db), PHONE, T0);
  expect(await verifyCode(db, PHONE, await lastCode(), plus(10 * MIN + 1))).toBeNull();
});

test("a second code within thirty seconds is refused and no text is sent", async () => {
  const sms = fakeSms(db);
  await requestCode(db, sms, PHONE, T0);
  const again = await requestCode(db, sms, PHONE, plus(29_000));
  expect(again.ok).toBe(false);
  expect(again.error).toMatch(/wait/i);
  const { rows } = await db.query("select count(*)::int as n from sms_outbox");
  expect(rows[0].n).toBe(1);
  expect((await requestCode(db, sms, PHONE, plus(31_000))).ok).toBe(true);
});

test("the code is not stored in readable form", async () => {
  await requestCode(db, fakeSms(db), PHONE, T0);
  const code = await lastCode();
  const { rows } = await db.query("select code_hash from otp_codes where address = $1", [PHONE]);
  expect(rows[0].code_hash).not.toContain(code);
});

test("a session ends after thirty days", async () => {
  await requestCode(db, fakeSms(db), PHONE, T0);
  const s = await verifyCode(db, PHONE, await lastCode(), T0);
  expect(await sessionUser(db, s!.sessionToken, plus(29 * DAY))).not.toBeNull();
  expect(await sessionUser(db, s!.sessionToken, plus(30 * DAY + MIN))).toBeNull();
});

test("an unknown session token is nobody", async () => {
  expect(await sessionUser(db, "nope", T0)).toBeNull();
});

test("setUserName trims and stores the name", async () => {
  await requestCode(db, fakeSms(db), PHONE, T0);
  const s = await verifyCode(db, PHONE, await lastCode(), T0);
  await setUserName(db, s!.userId, "  Sam  ");
  expect((await sessionUser(db, s!.sessionToken, T0))?.name).toBe("Sam");
});

const EMAIL = "ana@example.com";

test("an email code signs a person in and creates them with that email", async () => {
  const sms = fakeSms(db);
  expect(await requestCode(db, sms, EMAIL, T0)).toEqual({ ok: true });
  const session = await verifyCode(db, EMAIL, await lastCode(), plus(MIN));
  expect(session).not.toBeNull();
  const { rows } = await db.query("select id, email, phone from users");
  expect(rows).toEqual([{ id: session?.userId, email: EMAIL, phone: null }]);
  expect(await sessionUser(db, session!.sessionToken, plus(2 * MIN))).toEqual({
    id: session?.userId,
    email: EMAIL,
    phone: null,
    name: null,
  });
});

test("the same email in different capitals is one account", async () => {
  const sms = fakeSms(db);
  const typed = ["Ana@Example.com ", "ana@example.com"].map((t) => normalizeEmail(t)!);
  await requestCode(db, sms, typed[0], T0);
  const first = await verifyCode(db, typed[0], await lastCode(), plus(MIN));
  await requestCode(db, sms, typed[1], plus(2 * MIN));
  const second = await verifyCode(db, typed[1], await lastCode(), plus(3 * MIN));
  expect(second?.userId).toBe(first?.userId);
  expect((await db.query("select count(*)::int as n from users")).rows[0].n).toBe(1);
});

test("an email is not checked against the allowed phone prefixes", async () => {
  process.env.SMS_ALLOWED_PREFIXES = "+44";
  try {
    expect(await requestCode(db, fakeSms(db), EMAIL, T0)).toEqual({ ok: true });
  } finally {
    delete process.env.SMS_ALLOWED_PREFIXES;
  }
});

test("when the sender fails, asking for a code reports it instead of throwing", async () => {
  const broken = {
    send: async () => {
      throw new Error("smtp down");
    },
  };
  expect(await requestCode(db, broken, EMAIL, T0)).toEqual({
    ok: false,
    error: "Could not send the code. Try again in a minute.",
  });
});
