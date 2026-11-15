import { randomBytes } from "node:crypto";
import type { Db } from "@/db";
import { nextTermEnd } from "@/time";
import { logActivity } from "./activity";

export const DEFAULT_DEPOSIT_CENTS = 2000;
export const DEFAULT_TZ = "America/Toronto";
const MIN_DEPOSIT_CENTS = 500;
const MAX_DEPOSIT_CENTS = 20000;

export type Member = {
  id: string;
  houseId: string;
  userId: string;
  status: "pending" | "active" | "left";
  rotationPosition: number;
  autoReload: boolean;
  customerRef: string | null;
  name: string;
  phone: string;
};

export type House = {
  id: string;
  name: string;
  inviteCode: string;
  depositCents: number;
  tz: string;
  paused: boolean;
  settlementDate: string;
};

const MEMBER_COLUMNS = `m.id, m.house_id as "houseId", m.user_id as "userId", m.status,
  m.rotation_position as "rotationPosition", m.auto_reload as "autoReload", m.customer_ref as "customerRef",
  coalesce(u.name, 'Housemate') as name, u.phone`;

type Fail = { ok: false; error: string };

/** The membership a person currently holds, if any. A person is in at most one house. */
export async function memberForUser(db: Db, userId: string): Promise<Member | null> {
  const { rows } = await db.query<Member>(
    `select ${MEMBER_COLUMNS} from members m join users u on u.id = m.user_id
     where m.user_id = $1 and m.status <> 'left'`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function memberById(db: Db, memberId: string): Promise<Member | null> {
  const { rows } = await db.query<Member>(
    `select ${MEMBER_COLUMNS} from members m join users u on u.id = m.user_id where m.id = $1`,
    [memberId],
  );
  return rows[0] ?? null;
}

/** Housemates who have paid in, in rotation order. Only these are given chores. */
export async function activeMembers(db: Db, houseId: string): Promise<Member[]> {
  const { rows } = await db.query<Member>(
    `select ${MEMBER_COLUMNS} from members m join users u on u.id = m.user_id
     where m.house_id = $1 and m.status = 'active' order by m.rotation_position`,
    [houseId],
  );
  return rows;
}

export async function getHouse(db: Db, houseId: string): Promise<House | null> {
  const { rows } = await db.query<House>(
    `select id, name, invite_code as "inviteCode", deposit_cents as "depositCents", tz, paused,
            settlement_date as "settlementDate" from houses where id = $1`,
    [houseId],
  );
  return rows[0] ?? null;
}

export async function houseByInvite(db: Db, inviteCode: string): Promise<House | null> {
  const { rows } = await db.query<{ id: string }>("select id from houses where invite_code = $1", [
    inviteCode,
  ]);
  return rows[0] ? getHouse(db, rows[0].id) : null;
}

async function addMember(db: Db, houseId: string, userId: string, now: Date): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into members (house_id, user_id, rotation_position, joined_at)
     values ($1, $2, (select coalesce(max(rotation_position) + 1, 0) from members where house_id = $1), $3)
     returning id`,
    [houseId, userId, now],
  );
  return rows[0].id;
}

type CreateArgs = { userId: string; houseName: string; depositCents?: number; now: Date };

/** Starts a house. The creator is its first housemate, pending until they pay the deposit. */
export async function createHouse(
  db: Db,
  a: CreateArgs,
): Promise<{ ok: true; houseId: string; memberId: string; inviteCode: string } | Fail> {
  const name = a.houseName.trim().slice(0, 60);
  const depositCents = a.depositCents ?? DEFAULT_DEPOSIT_CENTS;
  if (!name) return { ok: false, error: "Give the house a name." };
  if (
    !Number.isInteger(depositCents) ||
    depositCents < MIN_DEPOSIT_CENTS ||
    depositCents > MAX_DEPOSIT_CENTS
  ) {
    return { ok: false, error: "The deposit must be between $5 and $200." };
  }
  if (await memberForUser(db, a.userId)) return { ok: false, error: "You are already in a house." };

  return db.tx(async (t) => {
    const inviteCode = randomBytes(6).toString("base64url").toLowerCase().replace(/[-_]/g, "x");
    const house = await t.query<{ id: string }>(
      `insert into houses (name, invite_code, deposit_cents, tz, settlement_date, created_at)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [name, inviteCode, depositCents, DEFAULT_TZ, nextTermEnd(a.now, DEFAULT_TZ), a.now],
    );
    const houseId = house.rows[0].id;
    const memberId = await addMember(t, houseId, a.userId, a.now);
    await logActivity(t, { houseId, memberId, kind: "house_created", data: { name }, now: a.now });
    return { ok: true as const, houseId, memberId, inviteCode };
  });
}

type JoinArgs = { userId: string; inviteCode: string; now: Date };

/** Joins a house by its invite code. The new housemate is pending until they pay the deposit. */
export async function joinHouse(db: Db, a: JoinArgs): Promise<{ ok: true; memberId: string } | Fail> {
  const house = await houseByInvite(db, a.inviteCode.trim());
  if (!house) return { ok: false, error: "That invite link does not match any house." };
  const existing = await memberForUser(db, a.userId);
  if (existing) {
    if (existing.houseId === house.id) return { ok: true, memberId: existing.id };
    return { ok: false, error: "You are already in another house. Leave it first." };
  }
  return db.tx(async (t) => {
    const memberId = await addMember(t, house.id, a.userId, a.now);
    await logActivity(t, { houseId: house.id, memberId, kind: "joined", now: a.now });
    return { ok: true as const, memberId };
  });
}

type PauseArgs = { houseId: string; memberId: string; paused: boolean; now: Date };

/** Pauses or resumes the whole house. While paused nothing is assigned and nothing is charged. */
export async function setPaused(db: Db, a: PauseArgs): Promise<void> {
  await db.tx(async (t) => {
    const changed = await t.query("update houses set paused = $2 where id = $1 and paused <> $2", [
      a.houseId,
      a.paused,
    ]);
    if (changed.rowCount === 0) return;
    if (a.paused) {
      await t.query("update turns set status = 'cancelled' where house_id = $1 and status = 'assigned'", [
        a.houseId,
      ]);
    }
    await logActivity(t, {
      houseId: a.houseId,
      memberId: a.memberId,
      kind: a.paused ? "paused" : "resumed",
      now: a.now,
    });
  });
}

export async function setAutoReload(db: Db, memberId: string, on: boolean): Promise<void> {
  await db.query("update members set auto_reload = $2 where id = $1", [memberId, on]);
}
