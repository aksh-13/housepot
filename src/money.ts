/**
 * Card fee shown on top of a payment so the house receives the full amount.
 * Based on 2.9% + 30 cents per card charge.
 */
export function feeCents(amountCents: number): number {
  return Math.ceil((amountCents + 30) / (1 - 0.029)) - amountCents;
}

/** "$25", "$12.50", "-$5" */
export function formatCents(cents: number): string {
  const abs = Math.abs(cents);
  const dollars = abs % 100 === 0 ? String(abs / 100) : (abs / 100).toFixed(2);
  return `${cents < 0 ? "-" : ""}$${dollars}`;
}
