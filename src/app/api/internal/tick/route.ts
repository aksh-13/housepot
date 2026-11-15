import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/db";
import { runTick } from "@/domain/tick";
import { getProviders } from "@/providers";

export const dynamic = "force-dynamic";

function authorised(req: Request): boolean {
  const secret = process.env.TICK_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Called every few minutes by the Kubernetes CronJob. */
export async function POST(req: Request): Promise<Response> {
  if (!authorised(req)) return new Response("unauthorised", { status: 401 });
  const baseUrl = process.env.BASE_URL ?? new URL(req.url).origin;
  const { sms, payments } = getProviders();
  const summary = await runTick(getDb(), { sms, payments }, new Date(), baseUrl);
  return Response.json(summary);
}
