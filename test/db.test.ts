import path from "node:path";
import { beforeEach, expect, test } from "vitest";
import { migrate } from "../scripts/migrate.mjs";
import { db, resetDb } from "./helpers";

beforeEach(resetDb);

test("a fresh database has the tables and no rows", async () => {
  const { rows } = await db.query("select count(*)::int as n from houses");
  expect(rows[0].n).toBe(0);
});

test("running migrations again changes nothing and does not throw", async () => {
  const applied = await migrate(process.env.DATABASE_URL!, path.resolve(__dirname, "../migrations"));
  expect(applied).toEqual([]);
});

test("a transaction that throws leaves nothing behind", async () => {
  await expect(
    db.tx(async (t) => {
      await t.query("insert into users (phone) values ('+19055550100')");
      throw new Error("boom");
    }),
  ).rejects.toThrow("boom");
  const { rows } = await db.query("select count(*)::int as n from users");
  expect(rows[0].n).toBe(0);
});

test("a nested transaction joins the outer one", async () => {
  await db.tx(async (outer) => {
    await outer.tx(async (inner) => {
      await inner.query("insert into users (phone) values ('+19055550101')");
    });
  });
  const { rows } = await db.query("select count(*)::int as n from users");
  expect(rows[0].n).toBe(1);
});
