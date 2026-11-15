import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/db";
import { handleInboundEmail, type InboundEmail } from "@/domain/inbound";
import { textDebtPaid } from "@/domain/settleup";
import { getProviders } from "@/providers";

export const dynamic = "force-dynamic";

function authorised(req: Request): boolean {
  const secret = process.env.INBOUND_EMAIL_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const isString = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;

function parse(body: unknown): InboundEmail | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (
    !isString(b.messageId, 1000) ||
    !b.messageId ||
    !isString(b.to, 1000) ||
    !isString(b.from, 1000) ||
    !isString(b.subject, 2000) ||
    !isString(b.text, 200_000) ||
    typeof b.authenticated !== "boolean"
  ) {
    return null;
  }
  return {
    messageId: b.messageId,
    to: b.to,
    from: b.from,
    subject: b.subject,
    text: b.text,
    authenticated: b.authenticated,
  };
}

/**
 * Whatever receives mail for the forwarding domain posts each email here as JSON:
 * { messageId, to, from, subject, text, authenticated }. `authenticated` must be the receiving
 * service's own DKIM check for the sender's domain. See README, "Checking payments automatically".
 */
export async function POST(req: Request): Promise<Response> {
  if (!authorised(req)) return new Response("unauthorised", { status: 401 });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response("not json", { status: 400 });
  }
  const email = parse(body);
  if (!email) return new Response("missing fields", { status: 400 });
  const handled = await handleInboundEmail(getDb(), email, new Date());
  if (handled.paid) {
    const baseUrl = process.env.BASE_URL ?? new URL(req.url).origin;
    await textDebtPaid(getProviders().sms, handled.paid, `${baseUrl}/settle`);
  }
  // Always 200 for an email we read, matched or not, so the sender does not keep retrying it.
  return Response.json({ outcome: handled.outcome });
}
