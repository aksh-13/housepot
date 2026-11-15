import path from "node:path";
import { type Db, getDb } from "@/db";
import { migrate } from "../scripts/migrate.mjs";

export const db: Db = getDb();

let migrated = false;

/** Applies migrations once per test run, then empties every table. */
export async function resetDb(): Promise<void> {
  if (!migrated) {
    await migrate(process.env.DATABASE_URL!, path.resolve(__dirname, "../migrations"));
    migrated = true;
  }
  const { rows } = await db.query<{ tablename: string }>(
    "select tablename from pg_tables where schemaname = 'public' and tablename <> 'schema_migrations'",
  );
  if (rows.length > 0) {
    const names = rows.map((r) => `"${r.tablename}"`).join(", ");
    await db.query(`truncate ${names} restart identity cascade`);
  }
}
