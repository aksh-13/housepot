import { beforeEach, expect, test } from "vitest";
import { getProviders } from "@/providers";
import { dbStorage } from "@/providers/storage";
import { db, resetDb } from "./helpers";

beforeEach(resetDb);

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 0, 255]);

test("a photo saved to the database reads back byte for byte", async () => {
  const storage = dbStorage(db);
  await storage.put("house-1/a.jpg", JPEG, "image/jpeg");
  const back = await storage.get("house-1/a.jpg");
  expect(back).toBeInstanceOf(Buffer);
  expect(back?.equals(JPEG)).toBe(true);
});

test("a photo that was never saved reads back as nothing", async () => {
  expect(await dbStorage(db).get("house-1/missing.jpg")).toBeNull();
});

test("saving to the same key again replaces the photo", async () => {
  const storage = dbStorage(db);
  await storage.put("house-1/a.jpg", JPEG, "image/jpeg");
  await storage.put("house-1/a.jpg", Buffer.from([9, 9]), "image/jpeg");
  expect((await storage.get("house-1/a.jpg"))?.equals(Buffer.from([9, 9]))).toBe(true);
});

test("STORAGE_PROVIDER=db keeps photos in the database with no other settings", async () => {
  const before = process.env.STORAGE_PROVIDER;
  process.env.STORAGE_PROVIDER = "db";
  try {
    const { storage } = getProviders();
    await storage.put("house-1/b.jpg", JPEG, "image/jpeg");
    const { rows } = await db.query("select storage_key, octet_length(bytes) as size from photo_files");
    expect(rows).toEqual([{ storage_key: "house-1/b.jpg", size: JPEG.length }]);
  } finally {
    if (before === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = before;
  }
});
