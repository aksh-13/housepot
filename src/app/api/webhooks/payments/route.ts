import { getDb } from "@/db";
import { applyPaymentEvent } from "@/domain/payments";
import { getProviders } from "@/providers";

export const dynamic = "force-dynamic";

/** The card processor calls this when a payment succeeds. The provider checks the signature. */
export async function POST(req: Request): Promise<Response> {
  const rawBody = await req.text();
  const signature = req.headers.get("stripe-signature") ?? req.headers.get("x-fake-signature");
  const event = await getProviders().payments.parseWebhook(rawBody, signature);
  if (!event) return new Response("ignored", { status: 400 });
  await applyPaymentEvent(getDb(), event, new Date());
  return new Response("ok", { status: 200 });
}
