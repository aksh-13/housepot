/**
 * Turning a receipt's text into bill lines, with plain rules and no AI model. The text comes from
 * reading a photo (see the bill form, which runs Tesseract in the browser), so it has the usual
 * misreadings: O for 0, commas for decimal points, stray symbols. The result is only ever a draft that
 * the person checks and fixes before saving: it never becomes a bill by itself.
 *
 * Runs in the browser and in tests. No database, no network.
 */

import { MAX_ITEM_NAME, MAX_ITEMS } from "./split";

export type ParsedReceipt = {
  items: { name: string; priceCents: number }[];
  /** Before tax and tip, as printed. Null when the receipt shows none (or it could not be read). */
  subtotalCents: number | null;
  /** Every tax line added up (HST, GST, PST, QST, "TAX"). */
  taxCents: number;
  tipCents: number;
  totalCents: number | null;
  /**
   * True when the items add up to the subtotal, which is the best sign the read was good. False
   * means something was missed or misread, and the person should look closely.
   */
  itemsMatchSubtotal: boolean;
};

/** A price at the end of a line, maybe followed by a tax flag such as "H", "HST", "T" or "*". */
const PRICE_AT_END = /(-?)\$?\s*(\d{1,5})\s*[.,]\s*(\d{2})\s*(-?)\s*(?:[A-Z]{1,3}|\*{1,2}|[A-Z]\s?\*)?\s*$/;

/** Lines that are about paying, not buying. Nothing after the total is an item either. */
const PAYMENT =
  /\b(CHANGE|CASH|VISA|MASTERCARD|MASTER CARD|AMEX|DEBIT|CREDIT|TENDER(ED)?|PAYMENT|APPROVED|AUTH|CARD|INTERAC|BALANCE|ROUNDING|SAVINGS|YOU SAVED|POINTS)\b/;
const SUBTOTAL = /\bSUB\s*-?\s*TOTAL\b|\bSUBTOT\b/;
const TOTAL = /\b(TOTAL|AMOUNT DUE|AMT DUE|GRAND TOTAL)\b/;
const TAX = /\b(HST|GST|PST|QST|TVQ|TPS|TVH|TAX|TAXES)\b/;
const TIP = /\b(TIP|GRATUITY)\b/;
const DISCOUNT = /\b(DISCOUNT|DISC|COUPON|OFF|SAVE|PROMO|REBATE|DEPOSIT REFUND)\b/;

/** Common misreadings inside a number: letter O for zero, l and I for one, S for five. */
function fixDigits(line: string): string {
  return line.replace(/[0-9OoIlSs$]+\s*[.,]\s*[0-9OoIlSs]{2}(?=\s*-?\s*(?:[A-Z]{1,3}|\*{1,2})?\s*$)/, (n) =>
    n
      .replace(/[Oo]/g, "0")
      .replace(/[Il]/g, "1")
      .replace(/[Ss](?=\d|[.,])/g, "5"),
  );
}

function priceOf(line: string): { cents: number; rest: string } | null {
  const m = PRICE_AT_END.exec(line);
  if (!m) return null;
  const cents = Number(m[2]) * 100 + Number(m[3]);
  const negative = m[1] === "-" || m[4] === "-";
  return { cents: negative ? -cents : cents, rest: line.slice(0, m.index) };
}

/** "0123456789 2% MILK 4L" reads as "2% Milk 4l": no item codes, tidier case, length capped. */
function tidyName(raw: string): string {
  const name = raw
    .replace(/^\s*\d{4,}\s+/, "") // item or barcode numbers at the start
    .replace(/^.*@.*$/, "") // "2 @ 1.99" or "1.32 kg @ $1.52/kg" is detail; the name is on the line above
    .replace(/[^\p{L}\p{N}%&'./\- ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase());
  return (name || "Item").slice(0, MAX_ITEM_NAME);
}

export function parseReceiptText(text: string): ParsedReceipt {
  const items: { name: string; priceCents: number }[] = [];
  let subtotalCents: number | null = null;
  let totalCents: number | null = null;
  let taxCents = 0;
  let tipCents = 0;

  // A line with no price is often the name for the price on the next ("BANANAS", then "2 @ 0.99 1.98").
  let pendingName = "";
  for (const original of text.split(/\r?\n/)) {
    const upper = fixDigits(original.toUpperCase().trim());
    if (!upper) continue;
    const price = priceOf(upper);
    if (!price) {
      pendingName = upper;
      continue;
    }
    if (totalCents !== null) break; // below the total: payment, change, card slip
    const named = pendingName;
    pendingName = "";
    if (SUBTOTAL.test(upper)) {
      subtotalCents = Math.abs(price.cents);
    } else if (TAX.test(price.rest)) {
      taxCents += Math.abs(price.cents);
    } else if (TIP.test(price.rest)) {
      tipCents += Math.abs(price.cents);
    } else if (TOTAL.test(price.rest)) {
      totalCents = Math.abs(price.cents);
    } else if (!PAYMENT.test(price.rest)) {
      if (price.cents < 0 || DISCOUNT.test(price.rest)) {
        // A discount takes money off the item above it.
        const last = items.at(-1);
        if (last) last.priceCents = Math.max(0, last.priceCents - Math.abs(price.cents));
      } else if (price.cents > 0 && items.length < MAX_ITEMS) {
        const own = tidyName(price.rest);
        items.push({ name: own === "Item" && named ? tidyName(named) : own, priceCents: price.cents });
      }
    }
  }

  const kept = items.filter((i) => i.priceCents > 0);
  const sum = kept.reduce((total, i) => total + i.priceCents, 0);
  // No subtotal printed: the total less tax and tip is the next best thing.
  if (subtotalCents === null && totalCents !== null && totalCents - taxCents - tipCents > 0) {
    subtotalCents = totalCents - taxCents - tipCents;
  }
  return {
    items: kept,
    subtotalCents,
    taxCents,
    tipCents,
    totalCents,
    itemsMatchSubtotal: subtotalCents !== null && kept.length > 0 && sum === subtotalCents,
  };
}
