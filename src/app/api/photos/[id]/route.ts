import { getDb } from "@/db";
import { memberForUser } from "@/domain/houses";
import { loadPhoto } from "@/domain/photos";
import { userFromRequest } from "@/lib/session";
import { getProviders } from "@/providers";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new Response("not found", { status: 404 });

/** Serves a proof photo, but only to someone who lives in the house it belongs to. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }): Promise<Response> {
  const { id } = await ctx.params;
  if (!UUID.test(id)) return notFound();
  const user = await userFromRequest(req);
  if (!user) return notFound();
  const db = getDb();
  const member = await memberForUser(db, user.id);
  if (!member) return notFound();
  const photo = await loadPhoto(db, getProviders().storage, id);
  if (!photo || photo.houseId !== member.houseId) return notFound();
  return new Response(new Uint8Array(photo.bytes), {
    status: 200,
    headers: { "content-type": photo.contentType, "cache-control": "private, max-age=86400" },
  });
}
