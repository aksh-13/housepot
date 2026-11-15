import { getDb } from "@/db";

export const dynamic = "force-dynamic";

/** Readiness: this pod can reach the database and may receive traffic. */
export async function GET(): Promise<Response> {
  try {
    await getDb().query("select 1");
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  } catch {
    return new Response("database unreachable", { status: 503, headers: { "content-type": "text/plain" } });
  }
}
