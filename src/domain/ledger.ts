import type { Db } from "@/db";

/** Where money sits: a housemate's balance, a chore's bounty, or outside the app (cards, e-Transfers). */
export type Account = { memberId: string } | { choreId: string } | "external";

export type TransferKind =
  | "deposit"
  | "topup"
  | "auto_reload"
  | "skip"
  | "miss"
  | "bounty_payout"
  | "dispute_reversal"
  | "cashout_refund"
  | "cashout_manual"
  | "writeoff"
  | "debt_carried"
  | "escrow_return"
  /** e-Transfer houses: a settle-up debt moves the winner and the loser back to zero. */
  | "settle_up"
  | "expense"
  | "expense_reversal";

type TransferArgs = {
  houseId: string;
  from: Account;
  to: Account;
  amountCents: number;
  kind: TransferKind;
  turnId?: string;
  /** Unique key that makes the transfer safe to retry: a second call with the same ref does nothing. */
  ref?: string;
};

function columns(account: Account): [string, string | null, string | null] {
  if (account === "external") return ["external", null, null];
  if ("memberId" in account) return ["member", account.memberId, null];
  return ["chore", null, account.choreId];
}

/** Moves money between two accounts as one pair of ledger rows that add up to zero. */
export async function transfer(
  db: Db,
  a: TransferArgs,
): Promise<{ transferId: string } | { duplicate: true }> {
  if (!Number.isInteger(a.amountCents) || a.amountCents <= 0) {
    throw new Error(`Transfer amount must be a positive whole number of cents, got ${a.amountCents}`);
  }
  return db.tx(async (t) => {
    const inserted = await t.query<{ id: string }>(
      `insert into transfers (house_id, kind, turn_id, ref) values ($1, $2, $3, $4)
       on conflict (ref) do nothing returning id`,
      [a.houseId, a.kind, a.turnId ?? null, a.ref ?? null],
    );
    if (inserted.rows.length === 0) return { duplicate: true as const };
    const transferId = inserted.rows[0].id;
    const [fromType, fromMember, fromChore] = columns(a.from);
    const [toType, toMember, toChore] = columns(a.to);
    await t.query(
      `insert into ledger_entries (transfer_id, house_id, account_type, member_id, chore_id, amount_cents)
       values ($1, $2, $3, $4, $5, $6), ($1, $2, $7, $8, $9, $10)`,
      [
        transferId,
        a.houseId,
        fromType,
        fromMember,
        fromChore,
        -a.amountCents,
        toType,
        toMember,
        toChore,
        a.amountCents,
      ],
    );
    return { transferId };
  });
}

export async function memberBalance(db: Db, memberId: string): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    "select coalesce(sum(amount_cents), 0)::int as total from ledger_entries where member_id = $1",
    [memberId],
  );
  return rows[0].total;
}

/** Money waiting on a chore for whoever does it. */
export async function choreBounty(db: Db, choreId: string): Promise<number> {
  const { rows } = await db.query<{ total: number }>(
    "select coalesce(sum(amount_cents), 0)::int as total from ledger_entries where chore_id = $1",
    [choreId],
  );
  return rows[0].total;
}

/**
 * Chore money not already set aside for a claim the house is voting on. That set-aside money is
 * still on the chore in the ledger, but it is promised to whoever sent the claim if it is approved.
 */
export async function availableBounty(db: Db, choreId: string): Promise<number> {
  const reserved = await db.query<{ cents: number }>(
    `select coalesce(sum(s.reserved_cents), 0)::int as cents
     from submissions s join turns tn on tn.id = s.turn_id
     where tn.chore_id = $1 and s.status = 'pending' and s.kind = 'claim'`,
    [choreId],
  );
  return Math.max(0, (await choreBounty(db, choreId)) - reserved.rows[0].cents);
}

export type MemberBalance = { memberId: string; name: string; status: string; balanceCents: number };

/** Everyone still in the house, in rotation order. */
export async function houseBalances(db: Db, houseId: string): Promise<MemberBalance[]> {
  const { rows } = await db.query<MemberBalance>(
    `select m.id as "memberId", coalesce(u.name, 'Housemate') as name, m.status,
            coalesce((select sum(amount_cents) from ledger_entries le where le.member_id = m.id), 0)::int as "balanceCents"
     from members m join users u on u.id = m.user_id
     where m.house_id = $1 and m.status <> 'left'
     order by m.rotation_position`,
    [houseId],
  );
  return rows;
}
