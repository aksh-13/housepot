import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { Db } from "@/db";

/** Where photo files are kept. The content type lives in the database, next to the key. */
export interface Storage {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
}

/** Keeps photos in a folder on disk. For development and tests. */
export function diskStorage(dir: string): Storage {
  const fileFor = (key: string) => {
    const file = path.resolve(dir, key);
    if (!file.startsWith(path.resolve(dir) + path.sep)) throw new Error("Invalid storage key");
    return file;
  };
  return {
    async put(key, bytes) {
      const file = fileFor(key);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    },
    async get(key) {
      try {
        return await readFile(fileFor(key));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },
  };
}

/**
 * Keeps photos in the app's own database. Nothing else to set up, which suits a small deployment
 * on a host with no disk (Vercel). Move to S3 or R2 when photos start to fill the database.
 */
export function dbStorage(db: Db): Storage {
  return {
    async put(key, bytes) {
      await db.query(
        `insert into photo_files (storage_key, bytes) values ($1, $2)
         on conflict (storage_key) do update set bytes = excluded.bytes`,
        [key, bytes],
      );
    },
    async get(key) {
      const { rows } = await db.query<{ bytes: Buffer }>(
        "select bytes from photo_files where storage_key = $1",
        [key],
      );
      return rows[0]?.bytes ?? null;
    },
  };
}

type S3Env = {
  S3_ENDPOINT?: string;
  S3_REGION: string;
  S3_BUCKET: string;
  S3_ACCESS_KEY_ID: string;
  S3_SECRET_ACCESS_KEY: string;
};

/** Keeps photos in any S3-compatible store: MinIO inside the cluster, or S3 / R2 in production. */
export function s3Storage(env: S3Env): Storage {
  const client = new S3Client({
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT || undefined,
    forcePathStyle: Boolean(env.S3_ENDPOINT),
    credentials: { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY },
  });
  return {
    async put(key, bytes, contentType) {
      await client.send(
        new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: bytes, ContentType: contentType }),
      );
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
        if (!res.Body) return null;
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if ((err as { name?: string }).name === "NoSuchKey") return null;
        throw err;
      }
    },
  };
}
