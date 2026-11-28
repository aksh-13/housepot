/**
 * Working out who owes what on a shared bill. Plain arithmetic in whole cents, with no database,
 * so the same code runs on the server (which decides) and in the browser (which previews).
 */

/** $10,000. A bill above this is far more likely a typo than a real house expense. */
export const MAX_BILL_CENTS = 1_000_000;
/** More lines than any real shared receipt. */
export const MAX_ITEMS = 100;
export const MAX_ITEM_NAME = 40;

/** One line of an item-by-item receipt: what it cost before tax, and who had it. */
export type ItemLine = { priceCents: number; memberIds: string[] };

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
  /**
   * Present for an item-by-item split. Each line is shared equally by whoever had it; that becomes
   * each person's own items, and the rest works exactly like a receipt split.
   */
  items?: { subtotalCents: number; lines: ItemLine[] };
  /** Present for a percentage split: each sharer's part in basis points (hundredths of a percent). */
  percentBp?: Record<string, number>;
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
  const { totalCents, payerId, sharerIds } = i;
  const fail = (error: string) => ({ ok: false as const, error });
  let receipt = i.receipt;

  if (!isAmount(totalCents)) return fail("The total must be between $0.01 and $10,000.");
  if (sharerIds.length === 0) return fail("Pick at least one person to share it.");
  if (new Set(sharerIds).size !== sharerIds.length) return fail("Each person can only be picked once.");
  if (sharerIds.length === 1 && sharerIds[0] === payerId)
    return fail("A bill only you share moves no money.");

  if (i.percentBp) return splitByPercent(i);
  if (i.items) {
    const own = itemsToOwn(i.items.lines, sharerIds);
    if (!own.ok) return own;
    receipt = { subtotalCents: i.items.subtotalCents, ownCents: own.ownCents };
  }

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

  handOutLeftover(shares, totalCents, payerId);
  return { ok: true, shares };
}

/**
 * Rounding each share down leaves fewer cents over than there are sharers. They are handed out one
 * each: the payer first if they are sharing (so the odd cent is theirs to absorb), then everyone else
 * in rotation order.
 */
function handOutLeftover(shares: Share[], totalCents: number, payerId: string): void {
  let leftover = totalCents - shares.reduce((sum, s) => sum + s.cents, 0);
  const order = [...shares].sort((a, b) => Number(b.memberId === payerId) - Number(a.memberId === payerId));
  for (const share of order) {
    if (leftover === 0) break;
    share.cents += 1;
    leftover -= 1;
  }
}

/**
 * What each person's own items came to, from an item-by-item receipt. A line is split equally between
 * whoever had it; its odd cents go to them in rotation order. Sharers who had nothing get nothing here
 * and pay only their part of whatever is left of the subtotal.
 */
export function itemsToOwn(
  lines: ItemLine[],
  sharerIds: string[],
): { ok: true; ownCents: Record<string, number> } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  if (lines.length === 0) return fail("Add at least one item.");
  if (lines.length > MAX_ITEMS) return fail(`A bill can have up to ${MAX_ITEMS} items.`);
  const ownCents: Record<string, number> = {};
  for (const line of lines) {
    if (!isAmount(line.priceCents)) return fail("Each item's price must be between $0.01 and $10,000.");
    if (line.memberIds.length === 0) return fail("Tick who had each item.");
    if (new Set(line.memberIds).size !== line.memberIds.length)
      return fail("Each person can only be ticked once.");
    if (line.memberIds.some((id) => !sharerIds.includes(id))) {
      return fail("An item is ticked for someone who is not sharing the bill.");
    }
    const who = [...line.memberIds].sort((a, b) => sharerIds.indexOf(a) - sharerIds.indexOf(b));
    const each = Math.floor(line.priceCents / who.length);
    const odd = line.priceCents - each * who.length;
    for (const [k, id] of who.entries()) ownCents[id] = (ownCents[id] ?? 0) + each + (k < odd ? 1 : 0);
  }
  return { ok: true, ownCents };
}

/** Each sharer pays their percentage of the total. The percentages must add up to exactly 100. */
function splitByPercent(i: SplitInput): { ok: true; shares: Share[] } | { ok: false; error: string } {
  const fail = (error: string) => ({ ok: false as const, error });
  const bp = i.percentBp ?? {};
  if (Object.keys(bp).some((id) => !i.sharerIds.includes(id))) {
    return fail("A percentage was entered for someone who is not sharing the bill.");
  }
  if (i.sharerIds.some((id) => !Number.isInteger(bp[id]) || bp[id] <= 0 || bp[id] > 10_000)) {
    return fail("Give everyone ticked a percentage above 0, or untick them.");
  }
  const sum = i.sharerIds.reduce((total, id) => total + bp[id], 0);
  if (sum !== 10_000) return fail(`The percentages add up to ${formatPercent(sum)}, not 100%.`);
  const shares = i.sharerIds.map((id) => ({
    memberId: id,
    cents: Math.floor((i.totalCents * bp[id]) / 10_000),
  }));
  handOutLeftover(shares, i.totalCents, i.payerId);
  return { ok: true, shares };
}

/** 3333 basis points reads "33.33%"; 5000 reads "50%". */
export function formatPercent(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`;
}

/** A percentage as a person types it, in basis points: "25", "33.33" and "12.5%" are fine. */
export function parsePercent(input: string): number | null {
  const m = input.trim().match(/^(\d{1,3})(?:\.(\d{1,2}))?\s*%?$/);
  if (!m) return null;
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  return bp <= 10_000 ? bp : null;
}

/** The fairest whole-basis-point equal split: 100% between 3 is 33.34, 33.33, 33.33. */
export function equalPercents(ids: string[]): Record<string, number> {
  const each = Math.floor(10_000 / Math.max(ids.length, 1));
  const odd = 10_000 - each * ids.length;
  return Object.fromEntries(ids.map((id, k) => [id, each + (k < odd ? 1 : 0)]));
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
