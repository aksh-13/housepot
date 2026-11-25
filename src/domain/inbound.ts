import { randomBytes } from "node:crypto";
import type { Db } from "@/db";
import { isFromInterac, parseInteracEmail } from "./interac";
import { type DebtView, debtsForUser, markDebtPaid } from "./settleup";

/**
 * Automatic payment checking. Each person gets a private forwarding address. They set up one email
 * filter that forwards only Interac's notifications there. When Interac says "Sam sent you $12"
 * with the debt's code in the message, the debt is marked paid with nobody tapping anything. When
 * Interac says "Priya has requested $12", the request link is saved so the payer's "Pay" button
 * opens it with everything filled in.
 *
 * Emails arrive through POST /api/webhooks/email from whatever receives mail for the domain
 * (a Cloudflare Email Worker, SendGrid Inbound Parse, ...). That service must check the email's
 * DKIM signature and say so in `authenticated`; an email that fails is recorded and ignored, so a
 * forged "you got paid" email cannot clear a debt.
 */

export type InboundEmail = {
  /** The Message-ID header. A second delivery of the same email does nothing. */
  messageId: string;
  /** The forwarding address it was sent to, pay-<token>@domain. */
  to: string;
  /** The original sender (for a forwarded email, the From header of the forwarded message). */
  from: string;
  subject: string;
  text: string;
  /** The receiving service verified a DKIM signature for the sender's domain. */
  authenticated: boolean;
};

export type InboundOutcome =
  | "duplicate"
  | "unknown_address"
  | "forwarding_code"
  | "not_authenticated"
  | "not_interac"
  | "unrecognised"
  | "paid"
  | "already_paid"
  | "amount_short"
  | "request_saved"
  | "request_without_link"
  | "no_match";

export function inboundDomain(): string {
  return process.env.INBOUND_EMAIL_DOMAIN ?? "pay.housepot.local";
}

/** This person's forwarding address. The private part is made the first time it is asked for. */
export async function forwardingAddress(db: Db, userId: string): Promise<string> {
  const token = randomBytes(8).toString("hex");
  const { rows } = await db.query<{ inbound_token: string }>(
    `update users set inbound_token = coalesce(inbound_token, $2) where id = $1 returning inbound_token`,
    [userId, token],
  );
  return `pay-${rows[0].inbound_token}@${inboundDomain()}`;
}

const tokenFrom = (to: string) => to.match(/pay-([a-f0-9]{16})@/i)?.[1]?.toLowerCase() ?? null;

/** Gmail sends a code to a new forwarding address before it will forward anything there. */
const GMAIL_FORWARDING = /forwarding-noreply@google\.com/i;

type Handled = { outcome: InboundOutcome; debtId?: string; paid?: DebtView };

/**
 * Handles one email that reached a forwarding address. Safe to call twice with the same email.
 * extraHosts: request links on these hosts are accepted too (the pretend Interac page in development).
 */
export async function handleInboundEmail(
  db: Db,
  email: InboundEmail,
  now: Date,
  opts: { extraHosts?: string[] } = {},
): Promise<Handled> {
  const token = tokenFrom(email.to);
  const user = token
    ? (await db.query<{ id: string }>("select id from users where inbound_token = $1", [token])).rows[0]
    : undefined;
  const recorded = await db.query<{ id: string }>(
    `insert into inbound_emails (message_id, user_id, from_address, subject, authenticated, kind, outcome, received_at)
     values ($1, $2, $3, $4, $5, 'unknown', 'processing', $6) on conflict (message_id) do nothing returning id`,
    [
      email.messageId.slice(0, 500),
      user?.id ?? null,
      email.from.slice(0, 500),
      email.subject.slice(0, 500),
      email.authenticated,
      now,
    ],
  );
  if (recorded.rows.length === 0) return { outcome: "duplicate" };
  const rowId = recorded.rows[0].id;
  const finish = async (h: Handled, kind = "unknown"): Promise<Handled> => {
    await db.query("update inbound_emails set outcome = $2, kind = $3, debt_id = $4 where id = $1", [
      rowId,
      h.outcome,
      kind,
      h.debtId ?? null,
    ]);
    return h;
  };

  if (!user) return finish({ outcome: "unknown_address" });

  if (GMAIL_FORWARDING.test(email.from)) {
    const code = `${email.subject}\n${email.text}`.match(/confirmation code[:\s]*([0-9]{6,12})/i)?.[1];
    if (code) await db.query("update users set forwarding_code = $2 where id = $1", [user.id, code]);
    return finish({ outcome: "forwarding_code" }, "gmail_forwarding");
  }
  if (!email.authenticated) return finish({ outcome: "not_authenticated" });
  if (!isFromInterac(email.from)) return finish({ outcome: "not_interac" });

  const parsed = parseInteracEmail(email, opts.extraHosts);
  if (!parsed) return finish({ outcome: "unrecognised" });

  const mine = await debtsForUser(db, user.id, 500);
  if (parsed.kind === "received") {
    // Money arrived for this person: one of the debts owed to them.
    const owedToMe = mine.filter((d) => d.toUserId === user.id);
    const match = pick(owedToMe, parsed.codes, parsed.amountCents, parsed.senderName, "from");
    if (match === "already_paid") return finish({ outcome: "already_paid" }, "received");
    if (!match) return finish({ outcome: "no_match" }, "received");
    if (parsed.amountCents < match.amountCents) {
      return finish({ outcome: "amount_short", debtId: match.id }, "received");
    }
    const paid = await markDebtPaid(db, { debtId: match.id, via: "email", now });
    if (!paid.ok) return finish({ outcome: "no_match" }, "received");
    return finish(
      {
        outcome: paid.changed ? "paid" : "already_paid",
        debtId: match.id,
        paid: paid.changed ? paid.debt : undefined,
      },
      "received",
    );
  }

  // A housemate asked this person for money: one of the debts they owe.
  const iOwe = mine.filter((d) => d.fromUserId === user.id);
  const match = pick(iOwe, parsed.codes, parsed.amountCents, parsed.requesterName, "to");
  if (match === "already_paid") return finish({ outcome: "already_paid" }, "request");
  if (!match) return finish({ outcome: "no_match" }, "request");
  if (!parsed.url) return finish({ outcome: "request_without_link", debtId: match.id }, "request");
  await db.query("update debts set request_url = $2 where id = $1 and status <> 'paid'", [
    match.id,
    parsed.url,
  ]);
  return finish({ outcome: "request_saved", debtId: match.id }, "request");
}

/**
 * Which debt an email is about. The code in the e-Transfer message decides it. Without a code, it
 * only matches when the name in Interac's email contains the other person's first name and exactly
 * one of their unpaid debts has that exact amount, so an unrelated $12 e-Transfer from someone else
 * never clears a debt.
 */
function pick(
  debts: DebtView[],
  codes: string[],
  amountCents: number,
  otherName: string | null,
  side: "from" | "to",
): DebtView | "already_paid" | null {
  if (codes.length > 0) {
    const byCode = debts.filter((d) => codes.includes(d.code));
    const unpaid = byCode.filter((d) => d.status !== "paid");
    if (unpaid.length === 1) return unpaid[0];
    if (byCode.length > 0) return "already_paid";
  }
  if (!otherName) return null;
  const said = otherName.toLowerCase();
  const byAmount = debts.filter((d) => {
    const first = (side === "from" ? d.fromName : d.toName).trim().split(/\s+/)[0]?.toLowerCase();
    return d.status !== "paid" && d.amountCents === amountCents && !!first && said.includes(first);
  });
  return byAmount.length === 1 ? byAmount[0] : null;
}

export type InboundView = {
  id: string;
  fromAddress: string;
  subject: string;
  outcome: string;
  kind: string;
  receivedAt: Date;
};

/** The last emails that reached this person's forwarding address, so they can see it is working. */
export async function recentInbound(db: Db, userId: string, limit = 5): Promise<InboundView[]> {
  const { rows } = await db.query<InboundView>(
    `select id, from_address as "fromAddress", subject, outcome, kind, received_at as "receivedAt"
     from inbound_emails where user_id = $1 order by received_at desc, id limit $2`,
    [userId, limit],
  );
  return rows;
}
