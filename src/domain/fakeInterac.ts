import { randomUUID } from "node:crypto";
import type { InboundEmail } from "./inbound";

/**
 * Pretend Interac emails, shaped the way src/domain/interac.ts expects real ones to look. Used by
 * the development inbox (/dev/inbox), the pretend Interac page, and the tests. When the parser is
 * adjusted to match real Interac emails, adjust these to match too.
 */

const FROM = "Interac e-Transfer <notify@payments.interac.ca>";
const dollars = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** What the person being paid receives when an e-Transfer lands. */
export function fakeReceivedEmail(a: {
  to: string;
  senderName: string;
  amountCents: number;
  message: string;
}): InboundEmail {
  return {
    messageId: `<fake-${randomUUID()}@payments.interac.ca>`,
    to: a.to,
    from: FROM,
    subject: `INTERAC e-Transfer: ${a.senderName} sent you money.`,
    text: [
      "Hi,",
      `${a.senderName} sent you ${dollars(a.amountCents)} (CAD) and the money has been automatically deposited into your bank account.`,
      `Message: ${a.message}`,
      "Reference Number: CAfake0000",
    ].join("\n"),
    authenticated: true,
  };
}

/** What the payer receives when the person they owe sends them an Interac money request. */
export function fakeRequestEmail(a: {
  to: string;
  requesterName: string;
  amountCents: number;
  message: string;
  url: string;
}): InboundEmail {
  return {
    messageId: `<fake-${randomUUID()}@payments.interac.ca>`,
    to: a.to,
    from: FROM,
    subject: `INTERAC e-Transfer: ${a.requesterName} has sent you a money request.`,
    text: [
      "Hi,",
      `${a.requesterName} has requested ${dollars(a.amountCents)} (CAD) from you.`,
      `Message: ${a.message}`,
      `To fulfil the request, go to: ${a.url}`,
    ].join("\n"),
    authenticated: true,
  };
}
