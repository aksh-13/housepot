export const dynamic = "force-dynamic";

/** Liveness: the process is up. Deliberately does not touch the database. */
export async function GET(): Promise<Response> {
  return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
}
