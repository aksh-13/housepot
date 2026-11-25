/**
 * Deployment settings read from environment variables. Each has a default that keeps local
 * development working with nothing set. A value that is not on the list is an error, never a
 * silent fallback: a typo must not quietly switch a safety setting back on or off.
 */
function setting<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const value = process.env[name] ?? fallback;
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}, but it is "${value}"`);
  }
  return value as T;
}

/** off: nobody can start a card house, and the pretend checkout and payments webhook are closed. */
export const cardHousesOn = (): boolean => setting("CARD_HOUSES", ["on", "off"], "on") === "on";

/**
 * How Interac emails are checked. fake: the development inbox and pretend Interac page exist.
 * webhook: real emails only, through /api/webhooks/email. off: no checking at all; housemates use
 * the "I sent it" and "It arrived" buttons.
 */
export const inboundMode = (): "fake" | "webhook" | "off" =>
  setting("INBOUND_EMAIL_PROVIDER", ["fake", "webhook", "off"], "fake");

/** Whether people sign in with a code sent to their phone or to their email. */
export const signInBy = (): "phone" | "email" => setting("SIGN_IN", ["phone", "email"], "phone");

/**
 * What sends email when people sign in by email. fake saves messages to the outbox instead, where
 * /dev/outbox shows them, sign-in codes included. So in production there is no default: fake has to
 * be written down on purpose, and a forgotten variable stops the app instead of exposing codes.
 */
export function emailProvider(): "fake" | "smtp" | "resend" {
  if (process.env.EMAIL_PROVIDER === undefined && process.env.NODE_ENV === "production") {
    throw new Error(
      "EMAIL_PROVIDER must be set in production: smtp, resend, or fake to save emails to /dev/outbox",
    );
  }
  return setting("EMAIL_PROVIDER", ["fake", "smtp", "resend"], "fake");
}
