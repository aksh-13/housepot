import path from "node:path";
import { getDb } from "@/db";
import { fakePayments, type Payments, stripePayments } from "./payments";
import { fakeSms, type Sms, twilioSms } from "./sms";
import { diskStorage, type Storage, s3Storage } from "./storage";

export type Providers = { sms: Sms; payments: Payments; storage: Storage };

const cache = globalThis as unknown as { __housepotProviders?: { key: string; providers: Providers } };

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function oneOf(name: string, value: string, allowed: string[]): void {
  if (!allowed.includes(value)) {
    throw new Error(name + " must be one of " + allowed.join(", ") + ', but it is "' + value + '"');
  }
}

export const smsIsFake = () => (process.env.SMS_PROVIDER ?? "fake") === "fake";
export const paymentsAreFake = () => (process.env.PAYMENTS_PROVIDER ?? "fake") === "fake";
/**
 * fake: the development inbox (/dev/inbox) and pretend Interac page exist, so the whole settle-up
 * flow can be tried with no email set up. webhook: only real emails, through /api/webhooks/email.
 */
export function inboundIsFake(): boolean {
  const kind = process.env.INBOUND_EMAIL_PROVIDER ?? "fake";
  // A typo must never quietly leave the pretend Interac pages switched on: anyone could mark debts paid.
  oneOf("INBOUND_EMAIL_PROVIDER", kind, ["fake", "webhook"]);
  return kind === "fake";
}

/**
 * The outside services, chosen by environment variables. With nothing set, everything is fake:
 * texts land in the sms_outbox table, payments use a pretend checkout page, photos go to disk.
 */
export function getProviders(): Providers {
  const smsKind = process.env.SMS_PROVIDER ?? "fake";
  const paymentsKind = process.env.PAYMENTS_PROVIDER ?? "fake";
  const storageKind = process.env.STORAGE_PROVIDER ?? "disk";
  const photoDir = process.env.PHOTO_DIR ?? path.resolve(process.cwd(), ".data/photos");
  // A typo must never quietly select the fake provider: in production that would mean free deposits.
  oneOf("SMS_PROVIDER", smsKind, ["fake", "twilio"]);
  oneOf("PAYMENTS_PROVIDER", paymentsKind, ["fake", "stripe"]);
  oneOf("STORAGE_PROVIDER", storageKind, ["disk", "s3"]);
  const key = [smsKind, paymentsKind, storageKind, photoDir].join("|");
  if (cache.__housepotProviders?.key === key) return cache.__housepotProviders.providers;

  const providers: Providers = {
    sms:
      smsKind === "twilio"
        ? twilioSms({
            TWILIO_ACCOUNT_SID: need("TWILIO_ACCOUNT_SID"),
            TWILIO_AUTH_TOKEN: need("TWILIO_AUTH_TOKEN"),
            TWILIO_FROM: need("TWILIO_FROM"),
          })
        : fakeSms(getDb()),
    payments:
      paymentsKind === "stripe"
        ? stripePayments({
            STRIPE_SECRET_KEY: need("STRIPE_SECRET_KEY"),
            STRIPE_WEBHOOK_SECRET: need("STRIPE_WEBHOOK_SECRET"),
          })
        : fakePayments(),
    storage:
      storageKind === "s3"
        ? s3Storage({
            S3_ENDPOINT: process.env.S3_ENDPOINT,
            S3_REGION: process.env.S3_REGION ?? "us-east-1",
            S3_BUCKET: need("S3_BUCKET"),
            S3_ACCESS_KEY_ID: need("S3_ACCESS_KEY_ID"),
            S3_SECRET_ACCESS_KEY: need("S3_SECRET_ACCESS_KEY"),
          })
        : diskStorage(photoDir),
  };
  cache.__housepotProviders = { key, providers };
  return providers;
}
