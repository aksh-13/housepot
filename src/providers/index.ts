import path from "node:path";
import { getDb } from "@/db";
import { emailProvider, inboundMode, signInBy } from "@/settings";
import { resendEmail, smtpEmail } from "./email";
import { fakePayments, type Payments, stripePayments } from "./payments";
import { fakeSms, type Sms, twilioSms } from "./sms";
import { dbStorage, diskStorage, type Storage, s3Storage } from "./storage";

/** `sms` carries every message the app sends: texts, or emails when people sign in by email. */
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

/** Which service carries messages: an email sender when people sign in by email, otherwise texts. */
const messageKind = (): string =>
  signInBy() === "email" ? `email-${emailProvider()}` : (process.env.SMS_PROVIDER ?? "fake");
/** True when messages are saved to the outbox instead of being sent. */
export const smsIsFake = () => ["fake", "email-fake"].includes(messageKind());
export const paymentsAreFake = () => (process.env.PAYMENTS_PROVIDER ?? "fake") === "fake";
/**
 * fake: the development inbox (/dev/inbox) and pretend Interac page exist, so the whole settle-up
 * flow can be tried with no email set up. webhook: only real emails, through /api/webhooks/email.
 */
export const inboundIsFake = (): boolean => inboundMode() === "fake";
/** No Interac emails are read at all: debts are marked by hand with "I sent it" and "It arrived". */
export const inboundIsOff = (): boolean => inboundMode() === "off";

/**
 * Builds each service the first time it is asked for, then keeps it. A service whose settings are
 * missing must only break the feature that needs it: photo storage that is not set up yet is no
 * reason for signing in to fail.
 */
function lazy<T extends object>(make: { [K in keyof T]: () => T[K] }): T {
  const built: Partial<T> = {};
  const out = {} as T;
  for (const name of Object.keys(make) as (keyof T)[]) {
    Object.defineProperty(out, name, {
      enumerable: true,
      get: () => {
        if (!(name in built)) built[name] = make[name]();
        return built[name];
      },
    });
  }
  return out;
}

/**
 * The outside services, chosen by environment variables. With nothing set, everything is fake:
 * texts land in the sms_outbox table, payments use a pretend checkout page, photos go to disk.
 */
export function getProviders(): Providers {
  const smsKind = messageKind();
  const paymentsKind = process.env.PAYMENTS_PROVIDER ?? "fake";
  const storageKind = process.env.STORAGE_PROVIDER ?? "disk";
  const photoDir = process.env.PHOTO_DIR ?? path.resolve(process.cwd(), ".data/photos");
  // A typo must never quietly select the fake provider: in production that would mean free deposits.
  oneOf("SMS_PROVIDER", smsKind, ["fake", "twilio", "email-fake", "email-smtp", "email-resend"]);
  oneOf("PAYMENTS_PROVIDER", paymentsKind, ["fake", "stripe"]);
  oneOf("STORAGE_PROVIDER", storageKind, ["disk", "s3", "db"]);
  const key = [smsKind, paymentsKind, storageKind, photoDir].join("|");
  if (cache.__housepotProviders?.key === key) return cache.__housepotProviders.providers;

  const providers = lazy<Providers>({
    sms: () =>
      smsKind === "twilio"
        ? twilioSms({
            TWILIO_ACCOUNT_SID: need("TWILIO_ACCOUNT_SID"),
            TWILIO_AUTH_TOKEN: need("TWILIO_AUTH_TOKEN"),
            TWILIO_FROM: need("TWILIO_FROM"),
          })
        : smsKind === "email-smtp"
          ? smtpEmail({
              SMTP_HOST: need("SMTP_HOST"),
              SMTP_PORT: need("SMTP_PORT"),
              SMTP_USER: need("SMTP_USER"),
              SMTP_PASS: need("SMTP_PASS"),
              EMAIL_FROM: need("EMAIL_FROM"),
            })
          : smsKind === "email-resend"
            ? resendEmail({ RESEND_API_KEY: need("RESEND_API_KEY"), EMAIL_FROM: need("EMAIL_FROM") })
            : fakeSms(getDb()),
    payments: () =>
      paymentsKind === "stripe"
        ? stripePayments({
            STRIPE_SECRET_KEY: need("STRIPE_SECRET_KEY"),
            STRIPE_WEBHOOK_SECRET: need("STRIPE_WEBHOOK_SECRET"),
          })
        : fakePayments(),
    storage: () =>
      storageKind === "s3"
        ? s3Storage({
            S3_ENDPOINT: process.env.S3_ENDPOINT,
            S3_REGION: process.env.S3_REGION ?? "us-east-1",
            S3_BUCKET: need("S3_BUCKET"),
            S3_ACCESS_KEY_ID: need("S3_ACCESS_KEY_ID"),
            S3_SECRET_ACCESS_KEY: need("S3_SECRET_ACCESS_KEY"),
          })
        : storageKind === "db"
          ? dbStorage(getDb())
          : diskStorage(photoDir),
  });
  cache.__housepotProviders = { key, providers };
  return providers;
}
