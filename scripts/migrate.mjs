// Applies migrations/*.sql in name order. Plain JavaScript so it runs in the container without a build step.
// Safe to run from several pods at once: a Postgres advisory lock lets one through at a time.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const LOCK_KEY = 4827001;

/**
 * @param {string} databaseUrl
 * @param {string} dir folder holding the .sql files
 * @returns {Promise<string[]>} names of the migrations applied by this call
 */
export async function migrate(databaseUrl, dir) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied = [];
  try {
    await client.query("select pg_advisory_lock($1)", [LOCK_KEY]);
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const done = new Set((await client.query("select name from schema_migrations")).rows.map((r) => r.name));
    const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), "utf8");
      await client.query("begin");
      try {
        await client.query(sql);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
        await client.query("commit");
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      applied.push(file);
    }
  } finally {
    await client.query("select pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
    await client.end();
  }
  return applied;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../migrations");
  // In a fresh cluster the database may still be starting. Keep trying for a minute before giving up.
  const deadline = Date.now() + Number(process.env.MIGRATE_WAIT_SECONDS ?? 60) * 1000;
  const run = async () => {
    for (;;) {
      try {
        return await migrate(url, dir);
      } catch (err) {
        const unreachable = ["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "57P03"].includes(err.code);
        if (!unreachable || Date.now() > deadline) throw err;
        console.log("Database not ready yet, retrying in 2s…");
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    }
  };
  run()
    .then((applied) => {
      console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
