import { randomBytes } from "node:crypto";
import type { Db } from "@/db";
import { cardHousesOn } from "@/settings";
import { nextMonthStart, nextTermEnd } from "@/time";
import { logActivity } from "./activity";
import { transfer } from "./ledger";

export const DEFAULT_DEPOSIT_CENTS = 2000;
export const DEFAULT_TZ = "America/Toronto";
const MIN_DEPOSIT_CENTS = 500;
const MAX_DEPOSIT_CENTS = 20000;

/**
 * How a house handles money.
 * card: everyone pays a real deposit by card, and the app holds the pot (the original design).
 * etransfer: no money is held. Balances are a scoreboard, and once a month housemates settle up by
 * sending each other e-Transfers.
 */
export type MoneyMode = "card" | "etransfer";

export type Member = {
  id: string;
  houseId: string;
  userId: string;
  status: "pending" | "active" | "left";
  rotationPosition: number;
  autoReload: boolean;
  customerRef: string | null;
  /** Where this housemate receives e-Transfers. Only used by houses that settle up by e-Transfer. */
  etransferEmail: string | null;
  /** Key from BANKS, for the "open my bank" button. */
  bank: string | null;
  name: string;
  /** Where messages for this person go: their email if they have one, otherwise their phone. */
  contact: string;
};

export type House = {
  id: string;
  name: string;
  inviteCode: string;
  depositCents: number;
  tz: string;
  paused: boolean;
  settlementDate: string;
  moneyMode: MoneyMode;
};

const MEMBER_COLUMNS = `m.id, m.house_id as "houseId", m.user_id as "userId", m.status,
  m.rotation_position as "rotationPosition", m.auto_reload as "autoReload", m.customer_ref as "customerRef",
  m.etransfer_email as "etransferEmail", m.bank, coalesce(u.name, 'Housemate') as name, coalesce(u.email, u.phone) as contact`;

export const HOUSE_COLUMNS = `id, name, invite_code as "inviteCode", deposit_cents as "depositCents", tz, paused,
  settlement_date as "settlementDate", money_mode as "moneyMode"`;

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

/** Housemates who are in the rotation (in a card house, the ones who have paid in), in rotation order. */
export async function activeMembers(db: Db, houseId: string): Promise<Member[]> {
  const { rows } = await db.query<Member>(
    `select ${MEMBER_COLUMNS} from members m join users u on u.id = m.user_id
     where m.house_id = $1 and m.status = 'active' order by m.rotation_position`,
    [houseId],
  );
  return rows;
}

export async function getHouse(db: Db, houseId: string): Promise<House | null> {
  const { rows } = await db.query<House>(`select ${HOUSE_COLUMNS} from houses where id = $1`, [houseId]);
  return rows[0] ?? null;
}

export async function houseByInvite(db: Db, inviteCode: string): Promise<House | null> {
  const { rows } = await db.query<{ id: string }>("select id from houses where invite_code = $1", [
    inviteCode,
  ]);
  return rows[0] ? getHouse(db, rows[0].id) : null;
}

/** A new housemate. In a card house they wait for their deposit; in an e-Transfer house they start at once. */
async function addMember(
  db: Db,
  houseId: string,
  userId: string,
  moneyMode: MoneyMode,
  now: Date,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    // In an e-Transfer house the sign-in email is where housemates send money, until they change it.
    `insert into members (house_id, user_id, rotation_position, joined_at, status, etransfer_email)
     values ($1, $2, (select coalesce(max(rotation_position) + 1, 0) from members where house_id = $1), $3, $4,
       case when $5 then (select email from users where id = $2) end)
     returning id`,
    [houseId, userId, now, moneyMode === "etransfer" ? "active" : "pending", moneyMode === "etransfer"],
  );
  return rows[0].id;
}

/** Card houses cash out at the end of term; e-Transfer houses settle up on the first of every month. */
export function nextSettlementDate(moneyMode: MoneyMode, now: Date, tz = DEFAULT_TZ): string {
  return moneyMode === "etransfer" ? nextMonthStart(now, tz) : nextTermEnd(now, tz);
}

type CreateArgs = {
  userId: string;
  houseName: string;
  depositCents?: number;
  moneyMode?: MoneyMode;
  now: Date;
};

/**
 * Starts a house. The creator is its first housemate: in a card house pending until they pay the
 * deposit, in an e-Transfer house active straight away.
 */
export async function createHouse(
  db: Db,
  a: CreateArgs,
): Promise<{ ok: true; houseId: string; memberId: string; inviteCode: string } | Fail> {
  const name = a.houseName.trim().slice(0, 60);
  const depositCents = a.depositCents ?? DEFAULT_DEPOSIT_CENTS;
  const moneyMode = a.moneyMode ?? "card";
  if (moneyMode !== "card" && moneyMode !== "etransfer") return { ok: false, error: "Pick how money works." };
  if (moneyMode === "card" && !cardHousesOn()) return { ok: false, error: "Card houses are switched off." };
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
      `insert into houses (name, invite_code, deposit_cents, tz, settlement_date, money_mode, created_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [name, inviteCode, depositCents, DEFAULT_TZ, nextSettlementDate(moneyMode, a.now), moneyMode, a.now],
    );
    const houseId = house.rows[0].id;
    const memberId = await addMember(t, houseId, a.userId, moneyMode, a.now);
    await logActivity(t, { houseId, memberId, kind: "house_created", data: { name, moneyMode }, now: a.now });
    return { ok: true as const, houseId, memberId, inviteCode };
  });
}

type JoinArgs = { userId: string; inviteCode: string; now: Date };

/** Joins a house by its invite code. In a card house the new housemate is pending until they pay the deposit. */
export async function joinHouse(db: Db, a: JoinArgs): Promise<{ ok: true; memberId: string } | Fail> {
  const house = await houseByInvite(db, a.inviteCode.trim());
  if (!house) return { ok: false, error: "That invite link does not match any house." };
  const existing = await memberForUser(db, a.userId);
  if (existing) {
    if (existing.houseId === house.id) return { ok: true, memberId: existing.id };
    return { ok: false, error: "You are already in another house. Leave it first." };
  }
  return db.tx(async (t) => {
    const memberId = await addMember(t, house.id, a.userId, house.moneyMode, a.now);
    // A debt that was written off when this person left comes back with them, so leaving and
    // rejoining is not a way to wipe it. The ref makes each old debt carry over exactly once.
    // (Only card houses write debts off. In an e-Transfer house a debt stays in the debts table.)
    const oldDebts = await t.query<{ member_id: string; cents: number }>(
      `select m.id as member_id, coalesce(sum(le.amount_cents), 0)::int as cents
       from members m
       join ledger_entries le on le.member_id = m.id
       join transfers tr on tr.id = le.transfer_id and tr.kind = 'writeoff'
       where m.house_id = $1 and m.user_id = $2 and m.status = 'left'
       group by m.id`,
      [house.id, a.userId],
    );
    for (const debt of oldDebts.rows) {
      if (debt.cents <= 0) continue;
      await transfer(t, {
        houseId: house.id,
        from: { memberId },
        to: "external",
        amountCents: debt.cents,
        kind: "debt_carried",
        ref: `carry:${debt.member_id}`,
      });
    }
    await logActivity(t, { houseId: house.id, memberId, kind: "joined", now: a.now });
    return { ok: true as const, memberId };
  });
}

type PauseArgs = { houseId: string; memberId: string; paused: boolean; now: Date };

/** Pauses or resumes the whole house. While paused nothing is assigned and nothing is charged. */
export async function setPaused(db: Db, a: PauseArgs): Promise<{ ok: true } | Fail> {
  const member = await memberById(db, a.memberId);
  if (!member || member.houseId !== a.houseId || member.status !== "active") {
    return { ok: false, error: "Only housemates who have paid in can pause or resume the house." };
  }
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
  return { ok: true };
}

export async function setAutoReload(db: Db, memberId: string, on: boolean): Promise<void> {
  await db.query("update members set auto_reload = $2 where id = $1", [memberId, on]);
}

/**
 * Banks for the "open my bank" button. These are the banks' public sites; on a phone with the bank's
 * app installed, some of them may open the app instead (not checked bank by bank). None of them can
 * be handed the amount or the recipient: there is no public way to fill in an e-Transfer from
 * outside the bank.
 */
export const BANKS: Record<string, { name: string; url: string }> = {
  rbc: { name: "RBC", url: "https://www.rbcroyalbank.com/" },
  td: { name: "TD", url: "https://www.td.com/ca/en/personal-banking" },
  scotiabank: { name: "Scotiabank", url: "https://www.scotiabank.com/" },
  bmo: { name: "BMO", url: "https://www.bmo.com/" },
  cibc: { name: "CIBC", url: "https://www.cibc.com/" },
  tangerine: { name: "Tangerine", url: "https://www.tangerine.ca/" },
  simplii: { name: "Simplii", url: "https://www.simplii.com/" },
  national: { name: "National Bank", url: "https://www.nbc.ca/" },
  desjardins: { name: "Desjardins", url: "https://www.desjardins.com/" },
  eq: { name: "EQ Bank", url: "https://www.eqbank.ca/" },
  wealthsimple: { name: "Wealthsimple", url: "https://www.wealthsimple.com/" },
  koho: { name: "KOHO", url: "https://www.koho.ca/" },
};

/** Normalised email, or null when it does not look like one. */
export function normalizeEmail(input: string): string | null {
  const email = input.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

type PayoutArgs = { memberId: string; etransferEmail: string; bank: string };

/** Saves where a housemate receives e-Transfers and which bank they pay from. Blank clears a field. */
export async function setPayoutDetails(db: Db, a: PayoutArgs): Promise<{ ok: true } | Fail> {
  const given = a.etransferEmail.trim();
  const email = given ? normalizeEmail(given) : null;
  if (given && !email) return { ok: false, error: "That does not look like an email address." };
  const bank = a.bank && Object.hasOwn(BANKS, a.bank) ? a.bank : null;
  await db.query("update members set etransfer_email = $2, bank = $3 where id = $1", [
    a.memberId,
    email,
    bank,
  ]);
  return { ok: true };
}
