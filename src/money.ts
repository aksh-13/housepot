/**
 * Card fee shown on top of a payment so the house receives the full amount.
 * Based on 2.9% + 30 cents per card charge.
 */
export function feeCents(amountCents: number): number {
  return Math.ceil((amountCents + 30) / (1 - 0.029)) - amountCents;
}

/** "25", "12.50", "1,200.50": whole dollars without ".00", thousands separated. */
export function dollars(absCents: number): string {
  const whole = Math.floor(absCents / 100).toLocaleString("en-US");
  const cents = absCents % 100;
  return cents === 0 ? whole : `${whole}.${String(cents).padStart(2, "0")}`;
}

/** "$25", "$12.50", "-$5", "$1,200.50" */
export function formatCents(cents: number): string {
  return `${cents < 0 ? "-" : ""}$${dollars(Math.abs(cents))}`;
}
