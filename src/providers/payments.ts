import { randomUUID } from "node:crypto";
import Stripe from "stripe";

export type PaymentPurpose = "deposit" | "topup" | "auto_reload";

/** What the app is told when money has really arrived. */
export type PaymentEvent = {
  type: "payment_succeeded";
  /** The provider's id for this payment. Used to credit it once and to refund it later. */
  providerRef: string;
  memberId: string;
  /** What goes into the member's balance. */
  amountCents: number;
  /** The card fee charged on top. */
  feeCents: number;
  purpose: PaymentPurpose;
  /** The provider's id for the saved card holder, when the card was saved. */
  customerRef?: string;
};

type CheckoutArgs = {
  memberId: string;
  amountCents: number;
  feeCents: number;
  purpose: "deposit" | "topup";
  saveCard: boolean;
  customerRef?: string;
  successUrl: string;
  cancelUrl: string;
};

type ChargeArgs = {
  memberId: string;
  customerRef: string;
  amountCents: number;
  feeCents: number;
  idempotencyKey: string;
};

type RefundArgs = { providerRef: string; amountCents: number; idempotencyKey: string };

export interface Payments {
  /** Returns a page to send the person to so they can pay by card. */
  createCheckout(a: CheckoutArgs): Promise<{ url: string }>;
  /** Charges a card saved earlier, with nobody present. */
  chargeSavedCard(a: ChargeArgs): Promise<{ ok: true; event: PaymentEvent } | { ok: false; reason: string }>;
  /** Sends money back to the card that made the payment. */
  refund(a: RefundArgs): Promise<{ ok: boolean }>;
  /** Turns a webhook request into an event, or null when it is not a genuine successful payment. */
  parseWebhook(rawBody: string, signature: string | null): Promise<PaymentEvent | null>;
}

const PURPOSES: PaymentPurpose[] = ["deposit", "topup", "auto_reload"];

function validEvent(e: any): e is PaymentEvent {
  return (
    e?.type === "payment_succeeded" &&
    typeof e.providerRef === "string" &&
    e.providerRef.length > 0 &&
    typeof e.memberId === "string" &&
    Number.isInteger(e.amountCents) &&
    e.amountCents > 0 &&
    Number.isInteger(e.feeCents) &&
    e.feeCents >= 0 &&
    PURPOSES.includes(e.purpose) &&
    (e.customerRef === undefined || typeof e.customerRef === "string")
  );
}

export type FakePayments = Payments & {
  /** Every refund asked for, so tests can check them. */
  refunds: RefundArgs[];
  charges: ChargeArgs[];
};

/**
 * A pretend card processor for development and tests. Checkout is a local page with a "Pay" button.
 * A customerRef starting with "fail" declines saved-card charges; a providerRef starting with
 * "norefund" refuses refunds.
 */
export function fakePayments(): FakePayments {
  const refunds: RefundArgs[] = [];
  const charges: ChargeArgs[] = [];
  return {
    refunds,
    charges,
    async createCheckout(a) {
      const event: PaymentEvent = {
        type: "payment_succeeded",
        providerRef: `fake_${randomUUID()}`,
        memberId: a.memberId,
        amountCents: a.amountCents,
        feeCents: a.feeCents,
        purpose: a.purpose,
        customerRef: a.saveCard ? (a.customerRef ?? `fakecus_${a.memberId}`) : undefined,
      };
      const payload = Buffer.from(
        JSON.stringify({ event, successUrl: a.successUrl, cancelUrl: a.cancelUrl }),
      ).toString("base64url");
      return { url: `/dev/fake-checkout?p=${payload}` };
    },
    async chargeSavedCard(a) {
      if (a.customerRef.startsWith("fail")) return { ok: false, reason: "card_declined" };
      charges.push(a);
      return {
        ok: true,
        event: {
          type: "payment_succeeded",
          providerRef: `fake_auto_${a.idempotencyKey}`,
          memberId: a.memberId,
          amountCents: a.amountCents,
          feeCents: a.feeCents,
          purpose: "auto_reload",
        },
      };
    },
    async refund(a) {
      if (a.providerRef.startsWith("norefund")) return { ok: false };
      refunds.push(a);
      return { ok: true };
    },
    async parseWebhook(rawBody, signature) {
      if (signature !== "fake") return null;
      try {
        const e = JSON.parse(rawBody);
        return validEvent(e) ? e : null;
      } catch {
        return null;
      }
    },
  };
}

type StripeEnv = { STRIPE_SECRET_KEY: string; STRIPE_WEBHOOK_SECRET: string };

/** Real card payments through Stripe Checkout, in Canadian dollars. */
export function stripePayments(env: StripeEnv): Payments {
  const stripe = new Stripe(env.STRIPE_SECRET_KEY);
  const metadata = (a: { memberId: string; amountCents: number; feeCents: number }, purpose: string) => ({
    memberId: a.memberId,
    amountCents: String(a.amountCents),
    feeCents: String(a.feeCents),
    purpose,
  });

  return {
    async createCheckout(a) {
      let customer = a.customerRef;
      if (a.saveCard && !customer) {
        customer = (await stripe.customers.create({ metadata: { memberId: a.memberId } })).id;
      }
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "cad",
              unit_amount: a.amountCents,
              product_data: { name: a.purpose === "deposit" ? "Housepot deposit" : "Housepot top-up" },
            },
          },
          {
            quantity: 1,
            price_data: {
              currency: "cad",
              unit_amount: a.feeCents,
              product_data: { name: "Card processing fee" },
            },
          },
        ],
        payment_intent_data: a.saveCard ? { setup_future_usage: "off_session" } : undefined,
        metadata: metadata(a, a.purpose),
        success_url: a.successUrl,
        cancel_url: a.cancelUrl,
      });
      if (!session.url) throw new Error("Stripe did not return a checkout page");
      return { url: session.url };
    },

    async chargeSavedCard(a) {
      try {
        const cards = await stripe.paymentMethods.list({ customer: a.customerRef, type: "card", limit: 1 });
        const card = cards.data[0];
        if (!card) return { ok: false, reason: "no_saved_card" };
        const intent = await stripe.paymentIntents.create(
          {
            amount: a.amountCents + a.feeCents,
            currency: "cad",
            customer: a.customerRef,
            payment_method: card.id,
            off_session: true,
            confirm: true,
            metadata: metadata(a, "auto_reload"),
          },
          { idempotencyKey: a.idempotencyKey },
        );
        if (intent.status !== "succeeded") return { ok: false, reason: intent.status };
        return {
          ok: true,
          event: {
            type: "payment_succeeded",
            providerRef: intent.id,
            memberId: a.memberId,
            amountCents: a.amountCents,
            feeCents: a.feeCents,
            purpose: "auto_reload",
          },
        };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : "charge_failed" };
      }
    },

    async refund(a) {
      try {
        await stripe.refunds.create(
          { payment_intent: a.providerRef, amount: a.amountCents },
          { idempotencyKey: a.idempotencyKey },
        );
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },

    async parseWebhook(rawBody, signature) {
      if (!signature) return null;
      let event: Stripe.Event;
      try {
        event = await stripe.webhooks.constructEventAsync(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
      } catch {
        return null;
      }
      if (event.type !== "checkout.session.completed") return null;
      const session = event.data.object;
      if (session.payment_status !== "paid" || typeof session.payment_intent !== "string") return null;
      const candidate = {
        type: "payment_succeeded",
        providerRef: session.payment_intent,
        memberId: session.metadata?.memberId,
        amountCents: Number(session.metadata?.amountCents),
        feeCents: Number(session.metadata?.feeCents),
        purpose: session.metadata?.purpose,
        customerRef: typeof session.customer === "string" ? session.customer : undefined,
      };
      return validEvent(candidate) ? candidate : null;
    },
  };
}
