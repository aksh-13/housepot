import { afterEach, beforeEach, expect, test } from "vitest";
import { getProviders } from "@/providers";

const NAMES = [
  "STORAGE_PROVIDER",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "PAYMENTS_PROVIDER",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SMS_PROVIDER",
  "SIGN_IN",
];
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

// Seen on the first production deploy: photo storage was not configured yet, and that made
// signing in crash, because every service was built the moment any one of them was asked for.
test("a service that is not configured only fails when it is used", () => {
  process.env.STORAGE_PROVIDER = "s3";
  process.env.S3_BUCKET = "housepot";
  const providers = getProviders();
  expect(typeof providers.sms.send).toBe("function");
  expect(typeof providers.payments.parseWebhook).toBe("function");
  expect(() => providers.storage).toThrow("S3_ACCESS_KEY_ID is not set");
});

test("missing payment keys do not stop messages or photos", () => {
  process.env.PAYMENTS_PROVIDER = "stripe";
  const providers = getProviders();
  expect(typeof providers.sms.send).toBe("function");
  expect(typeof providers.storage.put).toBe("function");
  expect(() => providers.payments).toThrow("STRIPE_SECRET_KEY is not set");
});

test("a typo in a provider name is still refused straight away", () => {
  process.env.STORAGE_PROVIDER = "s33";
  expect(() => getProviders()).toThrow(/STORAGE_PROVIDER must be one of disk, s3/);
});

test("each service is built once and reused", () => {
  const first = getProviders();
  expect(getProviders().sms).toBe(first.sms);
  expect(getProviders().storage).toBe(first.storage);
});
