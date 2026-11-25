import { afterEach, beforeEach, expect, test } from "vitest";
import { cardHousesOn, emailProvider, inboundMode, signInBy } from "@/settings";

const NAMES = ["CARD_HOUSES", "INBOUND_EMAIL_PROVIDER", "SIGN_IN", "EMAIL_PROVIDER", "NODE_ENV"];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
});

test("with nothing set, every setting keeps today's behaviour", () => {
  expect(cardHousesOn()).toBe(true);
  expect(inboundMode()).toBe("fake");
  expect(signInBy()).toBe("phone");
  expect(emailProvider()).toBe("fake");
});

test("card houses can be switched off", () => {
  process.env.CARD_HOUSES = "off";
  expect(cardHousesOn()).toBe(false);
  process.env.CARD_HOUSES = "on";
  expect(cardHousesOn()).toBe(true);
});

test("Interac checking is fake, webhook or off", () => {
  for (const mode of ["fake", "webhook", "off"] as const) {
    process.env.INBOUND_EMAIL_PROVIDER = mode;
    expect(inboundMode()).toBe(mode);
  }
});

test("sign-in is by phone or by email", () => {
  for (const mode of ["phone", "email"] as const) {
    process.env.SIGN_IN = mode;
    expect(signInBy()).toBe(mode);
  }
});

test("email goes out through the fake outbox, SMTP or Resend", () => {
  for (const kind of ["fake", "smtp", "resend"] as const) {
    process.env.EMAIL_PROVIDER = kind;
    expect(emailProvider()).toBe(kind);
  }
});

test("a typo in a setting is an error that names the setting, never a silent default", () => {
  process.env.CARD_HOUSES = "offf";
  expect(() => cardHousesOn()).toThrow(/CARD_HOUSES must be one of on, off/);
  process.env.INBOUND_EMAIL_PROVIDER = "offf";
  expect(() => inboundMode()).toThrow(/INBOUND_EMAIL_PROVIDER must be one of fake, webhook, off/);
  process.env.SIGN_IN = "offf";
  expect(() => signInBy()).toThrow(/SIGN_IN must be one of phone, email/);
  process.env.EMAIL_PROVIDER = "offf";
  expect(() => emailProvider()).toThrow(/EMAIL_PROVIDER must be one of fake, smtp, resend/);
});

// With the fake sender, /dev/outbox shows every sign-in code. In production that must be a choice
// someone wrote down, never what happens when a variable is forgotten.
test("in production the email sender has no default", () => {
  (process.env as Record<string, string>).NODE_ENV = "production";
  expect(() => emailProvider()).toThrow(/EMAIL_PROVIDER must be set in production/);
  process.env.EMAIL_PROVIDER = "fake";
  expect(emailProvider()).toBe("fake");
  process.env.EMAIL_PROVIDER = "resend";
  expect(emailProvider()).toBe("resend");
});
