import type { Db } from "@/db";
import { logActivity } from "./activity";
import { activeMembers, getHouse } from "./houses";
import { transfer } from "./ledger";
import { itemsToOwn, MAX_ITEM_NAME, parseDollars, parsePercent, type Share, splitBill } from "./split";

/**
 * Shared bills: groceries, internet, a restaurant receipt. One housemate paid; the others owe them
 * their share. Each share moves from the sharer's balance to the payer's in the same ledger chores
 * use, so a person has one balance and settle-up needs to know nothing about bills.
 *
 * A bill is never erased from the ledger. Editing or deleting one writes opposite transfers.
 */

export type BillInput = {
  description: string;
  totalCents: number;
  paidByMemberId: string;
  sharerMemberIds: string[];
  /** Present for a receipt split: the amount before tax and tip, and each person's own items. */
  receipt?: { subtotalCents: number; ownCents: Record<string, number> };
  /** Present for an item-by-item split: the amount before tax and tip, and every line with who had it. */
  items?: { subtotalCents: number; lines: BillItem[] };
  /** Present for a percentage split: each sharer's part in basis points (hundredths of a percent). */
  percentBp?: Record<string, number>;
};

export type BillItem = { name: string; priceCents: number; memberIds: string[] };
export type SplitKind = "equal" | "receipt" | "items" | "percent";

export type BillView = {
  id: string;
  houseId: string;
  description: string;
  totalCents: number;
  /** Null for an equal or percentage split. */
  subtotalCents: number | null;
  splitKind: SplitKind;
  /** The lines of an item-by-item bill, in receipt order. Empty otherwise. */
  items: BillItem[];
  paidByMemberId: string;
  paidByName: string;
  createdByName: string;
  createdAt: Date;
  edited: boolean;
  /** True once a settle-up has swept the bill up: it is part of those debts now. */
  locked: boolean;
  /** In rotation order. */
  shares: {
    memberId: string;
    name: string;
    ownCents: number | null;
    shareCents: number;
    percentBp: number | null;
  }[];
};

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

const MAX_DESCRIPTION = 60;
const MISSING = "That bill does not exist.";
const LOCKED = "This bill was already settled up, so it cannot be changed.";

/** Settle-up takes the same lock, so a bill cannot change while balances are being turned into debts. */
const lockHouse = (t: Db, houseId: string) =>
  t.query("select pg_advisory_xact_lock(hashtext($1))", [`house:${houseId}`]);

type Checked = {
  description: string;
  subtotalCents: number | null;
  splitKind: SplitKind;
  items: BillItem[];
  shares: (Share & { ownCents: number | null; percentBp: number | null })[];
};

/** Everything that can be wrong with a bill, checked before anything is written. */
async function check(t: Db, houseId: string, input: BillInput): Promise<({ ok: true } & Checked) | Fail> {
  const description = input.description.trim().slice(0, MAX_DESCRIPTION);
  if (!description) return fail("Say what the bill was for.");
  const active = (await activeMembers(t, houseId)).map((m) => m.id);
  const named = [input.paidByMemberId, ...input.sharerMemberIds];
  if (named.some((id) => !active.includes(id)))
    return fail("Everyone on a bill must be an active housemate.");
  // Rotation order decides who carries an odd cent, so it must not depend on the order of a form.
  const sharerIds = [...input.sharerMemberIds].sort((a, b) => active.indexOf(a) - active.indexOf(b));
  const items = (input.items?.lines ?? []).map((line) => ({
    ...line,
    name: line.name.trim().slice(0, MAX_ITEM_NAME) || "Item",
  }));
  const split = splitBill({
    totalCents: input.totalCents,
    payerId: input.paidByMemberId,
    sharerIds,
    receipt: input.receipt,
    items: input.items ? { subtotalCents: input.items.subtotalCents, lines: items } : undefined,
    percentBp: input.percentBp,
  });
  if (!split.ok) return split;
  const splitKind: SplitKind = input.percentBp
    ? "percent"
    : input.items
      ? "items"
      : input.receipt
        ? "receipt"
        : "equal";
  // What each person's own lines came to, kept on their share so the bill can show it.
  const itemOwn = input.items ? itemsToOwn(items, sharerIds) : null;
  const ownOf = (id: string): number | null =>
    splitKind === "items" && itemOwn?.ok
      ? (itemOwn.ownCents[id] ?? 0)
      : (input.receipt?.ownCents[id] ?? null);
  return {
    ok: true,
    description,
    splitKind,
    items: splitKind === "items" ? items : [],
    subtotalCents: input.items?.subtotalCents ?? input.receipt?.subtotalCents ?? null,
    shares: split.shares.map((s) => ({
      ...s,
      ownCents: ownOf(s.memberId),
      percentBp: splitKind === "percent" ? (input.percentBp?.[s.memberId] ?? null) : null,
    })),
  };
}

type Stored = { id: string; houseId: string; payerId: string; revision: number };

/** Writes a revision's lines and shares, and moves each sharer's part to the payer. */
async function apply(t: Db, bill: Stored, checked: Checked): Promise<void> {
  for (const [position, item] of checked.items.entries()) {
    await t.query("insert into bill_items (bill_id, position, name, price_cents) values ($1, $2, $3, $4)", [
      bill.id,
      position,
      item.name,
      item.priceCents,
    ]);
    for (const memberId of item.memberIds) {
      await t.query("insert into bill_item_sharers (bill_id, position, member_id) values ($1, $2, $3)", [
        bill.id,
        position,
        memberId,
      ]);
    }
  }
  for (const s of checked.shares) {
    await t.query(
      `insert into bill_shares (bill_id, member_id, own_cents, share_cents, percent_bp)
       values ($1, $2, $3, $4, $5)`,
      [bill.id, s.memberId, s.ownCents, s.cents, s.percentBp],
    );
    // The payer's own share moves nothing, and a transfer of zero cents is not a transfer.
    if (s.memberId === bill.payerId || s.cents === 0) continue;
    await transfer(t, {
      houseId: bill.houseId,
      from: { memberId: s.memberId },
      to: { memberId: bill.payerId },
      amountCents: s.cents,
      kind: "expense",
      ref: `bill:${bill.id}:${bill.revision}:${s.memberId}`,
    });
  }
}

/** Moves a revision's money back and clears its shares. The original ledger rows stay. */
async function undo(t: Db, bill: Stored): Promise<void> {
  const { rows } = await t.query<{ member_id: string; share_cents: number }>(
    "select member_id, share_cents from bill_shares where bill_id = $1",
    [bill.id],
  );
  for (const s of rows) {
    if (s.member_id === bill.payerId || s.share_cents === 0) continue;
    await transfer(t, {
      houseId: bill.houseId,
      from: { memberId: bill.payerId },
      to: { memberId: s.member_id },
      amountCents: s.share_cents,
      kind: "expense_reversal",
      ref: `bill:${bill.id}:${bill.revision}:${s.member_id}:undo`,
    });
  }
  await t.query("delete from bill_shares where bill_id = $1", [bill.id]);
  await t.query("delete from bill_items where bill_id = $1", [bill.id]);
}

type CreateArgs = {
  houseId: string;
  actorMemberId: string;
  input: BillInput;
  /** A token from the form. The same token twice makes one bill, so a double tap is harmless. */
  clientToken?: string;
  now: Date;
};

export async function createBill(db: Db, a: CreateArgs): Promise<{ ok: true; billId: string } | Fail> {
  const house = await getHouse(db, a.houseId);
  if (!house || house.moneyMode !== "etransfer")
    return fail("Bills are for houses that settle up by e-Transfer.");
  return db.tx(async (t) => {
    await lockHouse(t, a.houseId);
    if (!(await activeMembers(t, a.houseId)).some((m) => m.id === a.actorMemberId)) {
      return fail("Only housemates can add bills.");
    }
    const checked = await check(t, a.houseId, a.input);
    if (!checked.ok) return checked;
    // A double tap sends the same form twice: answer with the bill it already made. If the token
    // comes back with a different bill (the form was reopened with Back and changed), that is a
    // new bill and must not be dropped, so it is saved without the token.
    let clientToken = a.clientToken ?? null;
    if (clientToken) {
      const seen = await t.query<{ id: string; same: boolean }>(
        `select id, (description = $3 and total_cents = $4 and paid_by_member_id = $5) as same
         from bills where house_id = $1 and client_token = $2`,
        [a.houseId, clientToken, checked.description, a.input.totalCents, a.input.paidByMemberId],
      );
      if (seen.rows[0]?.same) return { ok: true as const, billId: seen.rows[0].id };
      if (seen.rows[0]) clientToken = null;
    }
    const inserted = await t.query<{ id: string }>(
      `insert into bills (house_id, description, total_cents, subtotal_cents, split_kind, paid_by_member_id,
         created_by_member_id, client_token, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) returning id`,
      [
        a.houseId,
        checked.description,
        a.input.totalCents,
        checked.subtotalCents,
        checked.splitKind,
        a.input.paidByMemberId,
        a.actorMemberId,
        clientToken,
        a.now,
      ],
    );
    const billId = inserted.rows[0].id;
    await apply(t, { id: billId, houseId: a.houseId, payerId: a.input.paidByMemberId, revision: 1 }, checked);
    await logActivity(t, {
      houseId: a.houseId,
      memberId: a.actorMemberId,
      kind: "bill_added",
      data: { billId, description: checked.description, totalCents: a.input.totalCents },
      now: a.now,
    });
    return { ok: true as const, billId };
  });
}

type Row = Stored & { description: string; totalCents: number; locked: boolean };

/**
 * The bill, if the actor is an active housemate of its house and it can still be changed. Takes the
 * house lock first, so "has a settle-up happened?" cannot change before the caller is done.
 */
async function changeable(
  t: Db,
  billId: string,
  actorMemberId: string,
): Promise<({ ok: true } & Row) | Fail> {
  const found = await t.query<{ houseId: string }>(
    `select b.house_id as "houseId" from bills b join members m on m.house_id = b.house_id
     where b.id::text = $1 and b.deleted_at is null and m.id = $2 and m.status = 'active'`,
    [billId, actorMemberId],
  );
  if (!found.rows[0]) return fail(MISSING);
  await lockHouse(t, found.rows[0].houseId);
  const { rows } = await t.query<Row>(
    `select b.id, b.house_id as "houseId", b.paid_by_member_id as "payerId", b.revision, b.description,
            b.total_cents as "totalCents",
            b.settled_at is not null as locked
     from bills b join houses h on h.id = b.house_id
     where b.id = $1 and b.deleted_at is null`,
    [billId],
  );
  const bill = rows[0];
  if (!bill) return fail(MISSING);
  if (bill.locked) return fail(LOCKED);
  return { ok: true, ...bill };
}

type EditArgs = { billId: string; actorMemberId: string; input: BillInput; now: Date };

/** Replaces a bill: the old shares are moved back and the new ones applied, in one transaction. */
export async function editBill(db: Db, a: EditArgs): Promise<{ ok: true } | Fail> {
  return db.tx(async (t) => {
    const bill = await changeable(t, a.billId, a.actorMemberId);
    if (!bill.ok) return bill;
    const checked = await check(t, bill.houseId, a.input);
    if (!checked.ok) return checked;
    await undo(t, bill);
    const revision = bill.revision + 1;
    await t.query(
      `update bills set description = $2, total_cents = $3, subtotal_cents = $4, paid_by_member_id = $5,
         revision = $6, updated_at = $7, split_kind = $8 where id = $1`,
      [
        bill.id,
        checked.description,
        a.input.totalCents,
        checked.subtotalCents,
        a.input.paidByMemberId,
        revision,
        a.now,
        checked.splitKind,
      ],
    );
    await apply(t, { ...bill, payerId: a.input.paidByMemberId, revision }, checked);
    await logActivity(t, {
      houseId: bill.houseId,
      memberId: a.actorMemberId,
      kind: "bill_edited",
      data: {
        billId: bill.id,
        description: checked.description,
        totalCents: a.input.totalCents,
        previousTotalCents: bill.totalCents,
      },
      now: a.now,
    });
    return { ok: true as const };
  });
}

type DeleteArgs = { billId: string; actorMemberId: string; now: Date };

/** Takes a bill back: balances return to where they were, and the bill leaves the list. */
export async function deleteBill(db: Db, a: DeleteArgs): Promise<{ ok: true } | Fail> {
  return db.tx(async (t) => {
    const bill = await changeable(t, a.billId, a.actorMemberId);
    if (!bill.ok) return bill;
    await undo(t, bill);
    await t.query("update bills set deleted_at = $2, updated_at = $2 where id = $1", [bill.id, a.now]);
    await logActivity(t, {
      houseId: bill.houseId,
      memberId: a.actorMemberId,
      kind: "bill_deleted",
      data: { billId: bill.id, description: bill.description, totalCents: bill.totalCents },
      now: a.now,
    });
    return { ok: true as const };
  });
}

const VIEW = `
  select b.id, b.house_id as "houseId", b.description, b.total_cents as "totalCents",
         b.subtotal_cents as "subtotalCents", b.split_kind as "splitKind", b.paid_by_member_id as "paidByMemberId",
         coalesce(pu.name, 'Housemate') as "paidByName", coalesce(cu.name, 'Housemate') as "createdByName",
         b.created_at as "createdAt", b.revision > 1 as edited,
         b.settled_at is not null as locked,
         coalesce((
           select json_agg(json_build_object('memberId', s.member_id, 'name', coalesce(su.name, 'Housemate'),
                    'ownCents', s.own_cents, 'shareCents', s.share_cents, 'percentBp', s.percent_bp)
                    order by sm.rotation_position)
           from bill_shares s join members sm on sm.id = s.member_id join users su on su.id = sm.user_id
           where s.bill_id = b.id), '[]'::json) as shares,
         coalesce((
           select json_agg(json_build_object('name', i.name, 'priceCents', i.price_cents,
                    'memberIds', coalesce((select json_agg(x.member_id) from bill_item_sharers x
                                           where x.bill_id = i.bill_id and x.position = i.position), '[]'::json))
                    order by i.position)
           from bill_items i where i.bill_id = b.id), '[]'::json) as items
  from bills b
  join houses h on h.id = b.house_id
  join members pm on pm.id = b.paid_by_member_id join users pu on pu.id = pm.user_id
  join members cm on cm.id = b.created_by_member_id join users cu on cu.id = cm.user_id
  where b.deleted_at is null`;

/** Bills that have not been deleted, newest first. */
export async function houseBills(db: Db, houseId: string, limit = 50): Promise<BillView[]> {
  const { rows } = await db.query<BillView>(
    `${VIEW} and b.house_id = $1 order by b.created_at desc, b.id desc limit $2`,
    [houseId, limit],
  );
  return rows;
}

export async function billById(db: Db, billId: string): Promise<BillView | null> {
  const { rows } = await db.query<BillView>(`${VIEW} and b.id::text = $1`, [billId]);
  return rows[0] ?? null;
}

/**
 * The add and edit forms, read into a bill. Field names: description, total, paidBy, split
 * ("equal", "receipt", "items" or "percent"), sharer (one per ticked person), and then:
 * receipt: subtotal, and own:<memberId> for each person's own items;
 * items: subtotal, line (one key per line, in order), and line:<key>:name, line:<key>:price and
 * line:<key>:who (one per person who had it);
 * percent: pct:<memberId> for each ticked person.
 * Only checks that the money parses; createBill and editBill check the rest.
 */
export function billInputFromForm(fd: FormData): { ok: true; input: BillInput } | Fail {
  const text = (key: string) => String(fd.get(key) ?? "").trim();
  const totalCents = parseDollars(text("total"));
  if (totalCents === null) return fail("The total is not an amount of money.");
  const sharerMemberIds = fd.getAll("sharer").map(String);
  const input: BillInput = {
    description: text("description"),
    totalCents,
    paidByMemberId: text("paidBy"),
    sharerMemberIds,
  };
  const kind = text("split");

  if (kind === "percent") {
    const percentBp: Record<string, number> = {};
    for (const id of sharerMemberIds) {
      const bp = parsePercent(text(`pct:${id}`));
      if (bp === null) return fail("One of the percentages is not a number from 0 to 100.");
      percentBp[id] = bp;
    }
    return { ok: true, input: { ...input, percentBp } };
  }
  if (kind !== "receipt" && kind !== "items") return { ok: true, input };

  const subtotalCents = parseDollars(text("subtotal"));
  if (subtotalCents === null) return fail("The subtotal is not an amount of money.");

  if (kind === "items") {
    const lines: BillItem[] = [];
    for (const key of fd.getAll("line").map(String)) {
      const priceCents = parseDollars(text(`line:${key}:price`));
      if (priceCents === null) return fail("One of the item prices is not an amount of money.");
      lines.push({
        name: text(`line:${key}:name`),
        priceCents,
        // Someone unticked from the bill is simply not on the line either.
        memberIds: fd
          .getAll(`line:${key}:who`)
          .map(String)
          .filter((id) => sharerMemberIds.includes(id)),
      });
    }
    return { ok: true, input: { ...input, items: { subtotalCents, lines } } };
  }

  const ownCents: Record<string, number> = {};
  // Someone unticked after their items were typed is simply not on the bill.
  for (const id of sharerMemberIds) {
    const typed = text(`own:${id}`);
    if (!typed) continue;
    const cents = parseDollars(typed);
    if (cents === null) return fail("One of the item amounts is not an amount of money.");
    ownCents[id] = cents;
  }
  return { ok: true, input: { ...input, receipt: { subtotalCents, ownCents } } };
}
