import type { Db } from "@/db";
import { feeCents } from "@/money";
import type { PaymentEvent, Payments } from "@/providers/payments";
import { logActivity } from "./activity";
import { getHouse, memberById } from "./houses";
import { memberBalance, transfer } from "./ledger";

/** What a member has to pay to be back at the house deposit. A debt is included. */
export async function amountDue(db: Db, memberId: string): Promise<number> {
  const member = await memberById(db, memberId);
  if (!member) return 0;
  const house = await getHouse(db, member.houseId);
  if (!house) return 0;
  return Math.max(0, house.depositCents - (await memberBalance(db, memberId)));
}

type CheckoutArgs = { memberId: string; saveCard: boolean; baseUrl: string };

/** Starts a card payment for whatever the member owes. Returns the page to send them to. */
export async function startCheckout(
  db: Db,
  payments: Payments,
  a: CheckoutArgs,
): Promise<{ url: string } | { error: string }> {
  const member = await memberById(db, a.memberId);
  if (!member || member.status === "left") return { error: "You are not in a house." };
  const due = await amountDue(db, a.memberId);
  if (due <= 0) return { error: "You are fully paid up." };
  return payments.createCheckout({
    memberId: a.memberId,
    amountCents: due,
    feeCents: feeCents(due),
    purpose: member.status === "pending" ? "deposit" : "topup",
    saveCard: a.saveCard,
    customerRef: member.customerRef ?? undefined,
    successUrl: `${a.baseUrl}/house?paid=1`,
    cancelUrl: `${a.baseUrl}/house`,
  });
}

/**
 * Records money that has arrived: credits the member's balance and makes a pending member active.
 * Safe to call more than once for the same payment; only the first call has any effect.
 */
export async function applyPaymentEvent(db: Db, e: PaymentEvent, now: Date): Promise<void> {
  const member = await memberById(db, e.memberId).catch(() => null);
  if (!member) return;
  await db.tx(async (t) => {
    const inserted = await t.query(
      `insert into payments (member_id, provider_ref, amount_cents, fee_cents, purpose, created_at)
       values ($1, $2, $3, $4, $5, $6) on conflict (provider_ref) do nothing`,
      [e.memberId, e.providerRef, e.amountCents, e.feeCents, e.purpose, now],
    );
    if (inserted.rowCount === 0) return;
    await transfer(t, {
      houseId: member.houseId,
      from: "external",
      to: { memberId: e.memberId },
      amountCents: e.amountCents,
      kind: e.purpose,
      ref: `pay:${e.providerRef}`,
    });
    await t.query(
      `update members set customer_ref = coalesce($2, customer_ref),
         status = case when status = 'pending' then 'active' else status end
       where id = $1`,
      [e.memberId, e.customerRef ?? null],
    );
    await logActivity(t, {
      houseId: member.houseId,
      memberId: e.memberId,
      kind:
        e.purpose === "deposit"
          ? "deposit_paid"
          : e.purpose === "auto_reload"
            ? "auto_reloaded"
            : "topped_up",
      data: { amountCents: e.amountCents },
      now,
    });
  });
}
