import path from "node:path";
import { type Db, getDb } from "@/db";
import { createHouse, joinHouse } from "@/domain/houses";
import { applyPaymentEvent } from "@/domain/payments";
import { migrate } from "../scripts/migrate.mjs";

export const db: Db = getDb();

let migrated = false;
let phoneCounter = 0;

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

/** A signed-up person with a unique phone number, and an email if one is given. Returns the user id. */
export async function makeUser(name: string, opts: { email?: string } = {}): Promise<string> {
  phoneCounter += 1;
  const phone = `+1905555${String(phoneCounter).padStart(4, "0")}`;
  const { rows } = await db.query("insert into users (phone, name, email) values ($1, $2, $3) returning id", [
    phone,
    name,
    opts.email ?? null,
  ]);
  return rows[0].id;
}

export type TestMember = { memberId: string; userId: string; name: string; phone: string };
export type TestHouse = { houseId: string; inviteCode: string; members: TestMember[] };

const NAMES = ["Ana", "Ben", "Cy", "Dee", "Eli", "Fay", "Gus", "Hal"];

/**
 * A house with `count` housemates. The first `active` of them (default: all) have paid the $20 deposit.
 * Members are returned in rotation order.
 */
export async function makeHouse(
  count: number,
  opts: { active?: number; now?: Date; moneyMode?: "card" | "etransfer" } = {},
): Promise<TestHouse> {
  const now = opts.now ?? new Date("2026-11-01T15:00:00Z");
  const moneyMode = opts.moneyMode ?? "card";
  // Nobody pays a deposit in an e-Transfer house: everyone is active from the moment they join.
  const active = moneyMode === "etransfer" ? 0 : (opts.active ?? count);
  const members: TestMember[] = [];
  let houseId = "";
  let inviteCode = "";
  for (let i = 0; i < count; i++) {
    const name = NAMES[i] ?? `M${i}`;
    const userId = await makeUser(name);
    let memberId: string;
    if (i === 0) {
      const h = await createHouse(db, { userId, houseName: "Test House", moneyMode, now });
      if (!h.ok) throw new Error(h.error);
      ({ houseId, inviteCode, memberId } = h);
    } else {
      const j = await joinHouse(db, { userId, inviteCode, now });
      if (!j.ok) throw new Error(j.error);
      memberId = j.memberId;
    }
    if (i < active) {
      await applyPaymentEvent(
        db,
        {
          type: "payment_succeeded",
          providerRef: `test_deposit_${memberId}`,
          memberId,
          amountCents: 2000,
          feeCents: 91,
          purpose: "deposit",
        },
        now,
      );
    }
    const { rows } = await db.query("select phone from users where id = $1", [userId]);
    members.push({ memberId, userId, name, phone: rows[0].phone });
  }
  return { houseId, inviteCode, members };
}
