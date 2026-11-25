/**
 * Working out who owes what on a shared bill. Plain arithmetic in whole cents, with no database,
 * so the same code runs on the server (which decides) and in the browser (which previews).
 */

/** $10,000. A bill above this is far more likely a typo than a real house expense. */
export const MAX_BILL_CENTS = 1_000_000;

export type SplitInput = {
  totalCents: number;
  payerId: string;
  /** In rotation order. */
  sharerIds: string[];
  /**
   * Present for a receipt split. subtotalCents is the amount before tax and tip. ownCents holds what
   * each person's own items came to, only for the sharers something was typed for.
   */
  receipt?: { subtotalCents: number; ownCents: Record<string, number> };
};

export type Share = { memberId: string; cents: number };

const isAmount = (cents: number) => Number.isInteger(cents) && cents >= 1 && cents <= MAX_BILL_CENTS;

/**
 * Each sharer's part of a bill, in the order the sharers were given. The parts always add up to
 * exactly the total.
 *
 * Equal split: the total divided between the sharers.
 * Receipt split: each person's own items, plus an equal part of whatever is left of the subtotal,
 * is their amount before tax. Tax and tip are spread in proportion to that amount.
 */
export function splitBill(i: SplitInput): { ok: true; shares: Share[] } | { ok: false; error: string } {
  const { totalCents, payerId, sharerIds, receipt } = i;
  const fail = (error: string) => ({ ok: false as const, error });

  if (!isAmount(totalCents)) return fail("The total must be between $0.01 and $10,000.");
  if (sharerIds.length === 0) return fail("Pick at least one person to share it.");
  if (new Set(sharerIds).size !== sharerIds.length) return fail("Each person can only be picked once.");
  if (sharerIds.length === 1 && sharerIds[0] === payerId)
    return fail("A bill only you share moves no money.");

  const own = (id: string) => receipt?.ownCents[id] ?? 0;
  if (receipt) {
    if (!isAmount(receipt.subtotalCents)) return fail("The subtotal must be between $0.01 and $10,000.");
    const typed = Object.entries(receipt.ownCents);
    if (typed.some(([, cents]) => !Number.isInteger(cents) || cents < 0)) {
      return fail("Each person's items must be $0 or more.");
    }
    if (typed.some(([id]) => !sharerIds.includes(id))) {
      return fail("Items were entered for someone who is not sharing the bill.");
    }
  }

  const n = sharerIds.length;
  // An equal split is a receipt where nobody typed any items: the whole amount is the shared part.
  const subtotal = receipt?.subtotalCents ?? totalCents;
  const shared = subtotal - sharerIds.reduce((sum, id) => sum + own(id), 0);
  if (shared < 0) return fail("The items add up to more than the subtotal.");

  // A person's amount before tax is own + shared / n. Multiplying through by n keeps it a whole
  // number: these weights are in units of 1/n of a cent and add up to subtotal * n.
  const weight = (id: string) => own(id) * n + shared;
  const shares = sharerIds.map((id) => ({
    memberId: id,
    cents: Math.floor((totalCents * weight(id)) / (subtotal * n)),
  }));

  // Rounding down leaves fewer than n cents over. Hand them out one each: the payer first if they
  // are sharing (so the odd cent is theirs to absorb), then everyone else in rotation order.
  let leftover = totalCents - shares.reduce((sum, s) => sum + s.cents, 0);
  const order = [...shares].sort((a, b) => Number(b.memberId === payerId) - Number(a.memberId === payerId));
  for (const share of order) {
    if (leftover === 0) break;
    share.cents += 1;
    leftover -= 1;
  }
  return { ok: true, shares };
}

/**
 * Money as a person types it, in cents: "12.5", "$1,200.50" and " 7 " are fine. Anything else
 * (words, negatives, three decimal places, nothing at all) is null.
 */
export function parseDollars(input: string): number | null {
  const m = input.trim().match(/^\$?\s*(?:(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?|\.(\d{1,2}))$/);
  if (!m) return null;
  const dollars = Number((m[1] ?? "0").replaceAll(",", ""));
  const cents = Number((m[2] ?? m[3] ?? "").padEnd(2, "0"));
  const total = dollars * 100 + cents;
  return Number.isSafeInteger(total) ? total : null;
}
