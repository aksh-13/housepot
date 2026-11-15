import { randomUUID } from "node:crypto";
import type { Db } from "@/db";
import type { Storage } from "@/providers/storage";
import { memberById } from "./houses";

export const MAX_PHOTO_BYTES = 8 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
};

type SaveArgs = { houseId: string; memberId: string; bytes: Buffer; contentType: string; now: Date };

/** Stores a proof photo. JPEG, PNG, WebP or HEIC, up to 8 MB. */
export async function savePhoto(
  db: Db,
  storage: Storage,
  a: SaveArgs,
): Promise<{ ok: true; photoId: string } | { ok: false; error: string }> {
  const ext = EXTENSIONS[a.contentType];
  if (!ext || a.bytes.length === 0) return { ok: false, error: "Add a photo (JPEG, PNG, WebP or HEIC)." };
  if (a.bytes.length > MAX_PHOTO_BYTES)
    return { ok: false, error: "That photo is over 8 MB. Try a smaller one." };
  const member = await memberById(db, a.memberId);
  if (!member || member.houseId !== a.houseId || member.status === "left") {
    return { ok: false, error: "Only housemates can add photos." };
  }
  const key = `${a.houseId}/${randomUUID()}.${ext}`;
  await storage.put(key, a.bytes, a.contentType);
  const { rows } = await db.query<{ id: string }>(
    `insert into photos (house_id, member_id, storage_key, content_type, created_at)
     values ($1, $2, $3, $4, $5) returning id`,
    [a.houseId, a.memberId, key, a.contentType, a.now],
  );
  return { ok: true, photoId: rows[0].id };
}

export async function loadPhoto(
  db: Db,
  storage: Storage,
  photoId: string,
): Promise<{ houseId: string; contentType: string; bytes: Buffer } | null> {
  const { rows } = await db.query<{ house_id: string; storage_key: string; content_type: string }>(
    "select house_id, storage_key, content_type from photos where id = $1",
    [photoId],
  );
  if (!rows[0]) return null;
  const bytes = await storage.get(rows[0].storage_key);
  return bytes ? { houseId: rows[0].house_id, contentType: rows[0].content_type, bytes } : null;
}
