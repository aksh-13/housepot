/**
 * Reading Interac e-Transfer notification emails.
 *
 * NOT YET CHECKED AGAINST REAL EMAILS. The patterns below are a best guess at what Interac's
 * notifications say ("... sent you money", "... has requested money", an amount like "$12.00",
 * the sender's message, a link to etransfer.interac.ca). Before relying on this, send yourselves a
 * $1 e-Transfer and a $1 money request, look at the raw emails, and adjust these patterns and the
 * tests in test/inbound.test.ts to match. Everything else (matching, marking paid, texts) does not
 * depend on the exact wording.
 */

/** Addresses Interac notifications are believed to come from. Unconfirmed: check a real email. */
const INTERAC_SENDER = /@(?:[a-z0-9-]+\.)*interac\.ca$/i;

/** True when the email claims to come from Interac. It still has to be authenticated (DKIM). */
export function isFromInterac(fromAddress: string): boolean {
  const address = fromAddress.match(/<([^>]+)>/)?.[1] ?? fromAddress;
  return INTERAC_SENDER.test(address.trim());
}

export type InteracEmail =
  | { kind: "received"; amountCents: number; senderName: string | null; codes: string[] }
  | {
      kind: "request";
      amountCents: number;
      requesterName: string | null;
      codes: string[];
      url: string | null;
    };

const AMOUNT = /\$\s?((?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.(\d{2}))?/;
const CODE = /\bHP-[A-HJ-NP-Z2-9]{4}\b/gi;
const LINK = /https?:\/\/[^\s"'<>)\]]+/g;

function amountCents(text: string): number | null {
  const m = text.match(AMOUNT);
  if (!m) return null;
  const cents = Number(m[1].replace(/,/g, "")) * 100 + Number(m[2] ?? 0);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

const codesIn = (text: string) => [...new Set((text.match(CODE) ?? []).map((c) => c.toUpperCase()))];

/**
 * Links that the "Pay" button may open: Interac's own pages. extraHosts lets the pretend Interac
 * page work in development.
 */
export function allowedRequestUrl(url: string, extraHosts: string[] = []): boolean {
  try {
    const u = new URL(url);
    if (extraHosts.includes(u.host)) return u.protocol === "https:" || u.protocol === "http:";
    return u.protocol === "https:" && (u.hostname === "interac.ca" || u.hostname.endsWith(".interac.ca"));
  } catch {
    return false;
  }
}

/** Pulls out what matters from an Interac notification, or null when it is not one we understand. */
export function parseInteracEmail(
  email: { subject: string; text: string },
  extraHosts: string[] = [],
): InteracEmail | null {
  const all = `${email.subject}\n${email.text}`;
  const cents = amountCents(all);
  if (!cents) return null;
  const codes = codesIn(all);

  // Checked first: a money request also talks about sending money.
  if (/money request|request(?:ed|s)? (?:money|\$|for)|requested/i.test(all)) {
    const name =
      email.subject.match(/:\s*(.+?)\s+(?:has\s+)?(?:sent you a money request|requested)/i)?.[1] ?? null;
    const url = (all.match(LINK) ?? []).find((u) => allowedRequestUrl(u, extraHosts)) ?? null;
    return { kind: "request", amountCents: cents, requesterName: name, codes, url };
  }
  if (/sent you money|sent you \$|deposited|has sent you/i.test(all)) {
    const name = email.subject.match(/:\s*(.+?)\s+(?:has\s+)?sent you/i)?.[1] ?? null;
    return { kind: "received", amountCents: cents, senderName: name, codes };
  }
  return null;
}
