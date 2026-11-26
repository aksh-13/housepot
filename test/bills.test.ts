import { beforeEach, expect, test } from "vitest";
import { recentActivity } from "@/domain/activity";
import {
  type BillInput,
  billById,
  billInputFromForm,
  createBill,
  deleteBill,
  editBill,
  houseBills,
} from "@/domain/bills";
import { memberBalance } from "@/domain/ledger";
import { settleUpHouse } from "@/domain/settleup";
import { db, makeHouse, resetDb, type TestHouse } from "./helpers";

const NOW = new Date("2026-11-11T17:00:00Z");
const LATER = new Date("2026-11-12T17:00:00Z");
const AFTER = new Date("2026-11-13T17:00:00Z");
const LOCKED = "This bill was already settled up, so it cannot be changed.";

let house: TestHouse;
let ana: string;
let ben: string;
let cy: string;

beforeEach(async () => {
  await resetDb();
  house = await makeHouse(3, { moneyMode: "etransfer" });
  [ana, ben, cy] = house.members.map((m) => m.memberId);
});

const balances = () => Promise.all([ana, ben, cy].map((m) => memberBalance(db, m)));
const count = async (table: string) =>
  (await db.query(`select count(*)::int as n from ${table}`)).rows[0].n as number;
const ledgerTotal = async () =>
  (await db.query("select coalesce(sum(amount_cents), 0)::int as t from ledger_entries")).rows[0].t;

const groceries = (over: Partial<BillInput> = {}): BillInput => ({
  description: "Groceries",
  totalCents: 9000,
  paidByMemberId: ana,
  sharerMemberIds: [ana, ben, cy],
  ...over,
});

async function add(input: BillInput, actor = ana, now = NOW, clientToken?: string): Promise<string> {
  const r = await createBill(db, { houseId: house.houseId, actorMemberId: actor, input, clientToken, now });
  if (!r.ok) throw new Error(r.error);
  return r.billId;
}

test("an equal bill moves each other sharer's part to the payer", async () => {
  await add(groceries());
  expect(await balances()).toEqual([6000, -3000, -3000]);
  expect(await ledgerTotal()).toBe(0);
});

test("a receipt bill charges each person their items plus their part of the tax", async () => {
  await add(
    groceries({
      totalCents: 6780,
      receipt: { subtotalCents: 6000, ownCents: { [ana]: 3000, [ben]: 1000 } },
    }),
  );
  expect(await balances()).toEqual([2636, -1883, -753]);
});

test("the payer does not have to be a sharer", async () => {
  await add(groceries({ totalCents: 1000, sharerMemberIds: [ben, cy] }));
  expect(await balances()).toEqual([1000, -500, -500]);
});

test("the sharers are split in rotation order whatever order they were given in", async () => {
  // Ana pays $10.01 for Ben and Cy. The odd cent goes to Ben, who is first in the rotation.
  await add(groceries({ totalCents: 1001, sharerMemberIds: [cy, ben] }));
  expect(await balances()).toEqual([1001, -501, -500]);
});

test("a bill reads back with who paid, who added it and each person's share", async () => {
  const billId = await add(
    groceries({
      description: "  Costco run  ",
      totalCents: 6780,
      receipt: { subtotalCents: 6000, ownCents: { [ana]: 3000, [ben]: 1000 } },
    }),
    ben,
  );
  expect(await billById(db, billId)).toEqual({
    id: billId,
    houseId: house.houseId,
    description: "Costco run",
    totalCents: 6780,
    subtotalCents: 6000,
    paidByMemberId: ana,
    paidByName: "Ana",
    createdByName: "Ben",
    createdAt: NOW,
    edited: false,
    locked: false,
    shares: [
      { memberId: ana, name: "Ana", ownCents: 3000, shareCents: 4144 },
      { memberId: ben, name: "Ben", ownCents: 1000, shareCents: 1883 },
      { memberId: cy, name: "Cy", ownCents: null, shareCents: 753 },
    ],
  });
});

test("a long description is cut to 60 characters", async () => {
  const billId = await add(groceries({ description: "x".repeat(80) }));
  expect((await billById(db, billId))?.description).toBe("x".repeat(60));
});

test("adding a bill shows in the activity feed", async () => {
  const billId = await add(groceries(), ben);
  const [latest] = await recentActivity(db, house.houseId, 1);
  expect(latest).toMatchObject({
    kind: "bill_added",
    memberId: ben,
    data: { billId, description: "Groceries", totalCents: 9000 },
  });
});

test("the same form token makes one bill", async () => {
  const first = await add(groceries(), ana, NOW, "t1");
  const second = await add(groceries(), ana, LATER, "t1");
  expect(second).toBe(first);
  expect(await count("bills")).toBe(1);
  expect(await balances()).toEqual([6000, -3000, -3000]);
});

test("bills are listed newest first, without deleted ones", async () => {
  const older = await add(groceries({ description: "Older" }), ana, NOW);
  const newer = await add(groceries({ description: "Newer" }), ana, LATER);
  const gone = await add(groceries({ description: "Gone" }), ana, AFTER);
  await deleteBill(db, { billId: gone, actorMemberId: ana, now: AFTER });
  expect((await houseBills(db, house.houseId)).map((b) => b.id)).toEqual([newer, older]);
});

test("deleting a bill puts every balance back and keeps the ledger rows", async () => {
  const billId = await add(groceries());
  const before = await count("ledger_entries");
  expect(await deleteBill(db, { billId, actorMemberId: ana, now: LATER })).toEqual({ ok: true });
  expect(await balances()).toEqual([0, 0, 0]);
  expect(await count("ledger_entries")).toBe(before * 2);
  const kinds = await db.query("select kind, count(*)::int as n from transfers group by kind order by kind");
  expect(kinds.rows).toEqual([
    { kind: "expense", n: 2 },
    { kind: "expense_reversal", n: 2 },
  ]);
  expect(await houseBills(db, house.houseId)).toEqual([]);
  expect(await billById(db, billId)).toBeNull();
  expect((await recentActivity(db, house.houseId, 1))[0]).toMatchObject({
    kind: "bill_deleted",
    memberId: ana,
    data: { billId, description: "Groceries", totalCents: 9000 },
  });
});

test("deleting a bill twice is refused the second time and moves nothing", async () => {
  const billId = await add(groceries());
  await deleteBill(db, { billId, actorMemberId: ana, now: LATER });
  expect(await deleteBill(db, { billId, actorMemberId: ana, now: LATER })).toEqual({
    ok: false,
    error: "That bill does not exist.",
  });
  expect(await balances()).toEqual([0, 0, 0]);
});

test("editing a bill replaces its effect on balances", async () => {
  const billId = await add(groceries());
  const edited = await editBill(db, {
    billId,
    actorMemberId: ana,
    input: groceries({ description: "Groceries (fixed)", totalCents: 6000, sharerMemberIds: [ana, ben] }),
    now: LATER,
  });
  expect(edited).toEqual({ ok: true });
  expect(await balances()).toEqual([3000, -3000, 0]);
  expect(await ledgerTotal()).toBe(0);
  const bill = await billById(db, billId);
  expect(bill).toMatchObject({ description: "Groceries (fixed)", totalCents: 6000, edited: true });
  expect(bill?.shares.map((s) => s.memberId)).toEqual([ana, ben]);
  expect((await recentActivity(db, house.houseId, 1))[0]).toMatchObject({
    kind: "bill_edited",
    memberId: ana,
    data: { billId, description: "Groceries (fixed)", totalCents: 6000 },
  });
});

test("a bill can be edited more than once, and to a different payer", async () => {
  const billId = await add(groceries());
  await editBill(db, { billId, actorMemberId: ana, input: groceries({ totalCents: 3000 }), now: LATER });
  await editBill(db, {
    billId,
    actorMemberId: ana,
    input: groceries({ totalCents: 3000, paidByMemberId: ben }),
    now: AFTER,
  });
  expect(await balances()).toEqual([-1000, 2000, -1000]);
});

test("any active housemate can edit or delete a bill they did not add", async () => {
  const billId = await add(groceries(), ana);
  expect(
    await editBill(db, { billId, actorMemberId: cy, input: groceries({ totalCents: 3000 }), now: LATER }),
  ).toEqual({ ok: true });
  expect(await deleteBill(db, { billId, actorMemberId: ben, now: LATER })).toEqual({ ok: true });
});

test("a bill added before a settle-up is locked", async () => {
  const billId = await add(groceries(), ana, NOW);
  await settleUpHouse(db, { houseId: house.houseId, now: LATER, reason: "early" });
  const settled = await balances();
  expect(
    await editBill(db, { billId, actorMemberId: ana, input: groceries({ totalCents: 100 }), now: AFTER }),
  ).toEqual({ ok: false, error: LOCKED });
  expect(await deleteBill(db, { billId, actorMemberId: ana, now: AFTER })).toEqual({
    ok: false,
    error: LOCKED,
  });
  expect((await billById(db, billId))?.locked).toBe(true);
  expect(await balances()).toEqual(settled);
});

test("a bill added after a settle-up is not locked", async () => {
  await settleUpHouse(db, { houseId: house.houseId, now: NOW, reason: "early" });
  const billId = await add(groceries(), ana, LATER);
  expect((await billById(db, billId))?.locked).toBe(false);
  expect(await deleteBill(db, { billId, actorMemberId: ana, now: AFTER })).toEqual({ ok: true });
});

test("an edit that names someone who has left is refused and changes nothing", async () => {
  const billId = await add(groceries({ sharerMemberIds: [ana, ben] }));
  await db.query("update members set status = 'left' where id = $1", [cy]);
  const edited = await editBill(db, { billId, actorMemberId: ana, input: groceries(), now: LATER });
  expect(edited).toEqual({ ok: false, error: "Everyone on a bill must be an active housemate." });
  expect(await balances()).toEqual([4500, -4500, 0]);
  expect((await billById(db, billId))?.edited).toBe(false);
});

test("a bill someone who has since left was on can still be deleted", async () => {
  const billId = await add(groceries());
  await db.query("update members set status = 'left' where id = $1", [cy]);
  expect(await deleteBill(db, { billId, actorMemberId: ana, now: LATER })).toEqual({ ok: true });
  expect(await balances()).toEqual([0, 0, 0]);
});

async function refusedAdd(input: BillInput, actor: string, houseId = house.houseId): Promise<string> {
  const r = await createBill(db, { houseId, actorMemberId: actor, input, now: NOW });
  expect(await count("bills")).toBe(0);
  expect(await count("transfers")).toBe(0);
  return r.ok ? "accepted" : r.error;
}

test("bills are refused in a card house", async () => {
  const card = await makeHouse(2, { moneyMode: "card", active: 0 });
  const [m1, m2] = card.members.map((m) => m.memberId);
  await db.query("update members set status = 'active' where house_id = $1", [card.houseId]);
  const input = groceries({ paidByMemberId: m1, sharerMemberIds: [m1, m2] });
  expect(await refusedAdd(input, m1, card.houseId)).toBe(
    "Bills are for houses that settle up by e-Transfer.",
  );
});

test("only an active housemate of the house can add a bill", async () => {
  const other = await makeHouse(1, { moneyMode: "etransfer" });
  expect(await refusedAdd(groceries(), other.members[0].memberId)).toBe("Only housemates can add bills.");
  await db.query("update members set status = 'left' where id = $1", [cy]);
  expect(await refusedAdd(groceries({ sharerMemberIds: [ana, ben] }), cy)).toBe(
    "Only housemates can add bills.",
  );
});

test("the payer and every sharer must be active housemates of this house", async () => {
  const other = await makeHouse(1, { moneyMode: "etransfer" });
  const stranger = other.members[0].memberId;
  const error = "Everyone on a bill must be an active housemate.";
  expect(await refusedAdd(groceries({ paidByMemberId: stranger }), ana)).toBe(error);
  expect(await refusedAdd(groceries({ sharerMemberIds: [ana, stranger] }), ana)).toBe(error);
});

test("a bill needs a description", async () => {
  expect(await refusedAdd(groceries({ description: "   " }), ana)).toBe("Say what the bill was for.");
});

test("a split that does not work is refused with the split's own message", async () => {
  expect(await refusedAdd(groceries({ totalCents: 0 }), ana)).toBe(
    "The total must be between $0.01 and $10,000.",
  );
  expect(await refusedAdd(groceries({ sharerMemberIds: [ana] }), ana)).toBe(
    "A bill only you share moves no money.",
  );
});

test("a bill that does not exist, or belongs to another house, cannot be edited or deleted", async () => {
  const billId = await add(groceries());
  const other = await makeHouse(1, { moneyMode: "etransfer" });
  const stranger = other.members[0].memberId;
  const missing = { ok: false, error: "That bill does not exist." };
  expect(await deleteBill(db, { billId, actorMemberId: stranger, now: LATER })).toEqual(missing);
  expect(await editBill(db, { billId, actorMemberId: stranger, input: groceries(), now: LATER })).toEqual(
    missing,
  );
  const unknown = "00000000-0000-4000-8000-000000000000";
  expect(await deleteBill(db, { billId: unknown, actorMemberId: ana, now: LATER })).toEqual(missing);
  expect(await deleteBill(db, { billId: "not-an-id", actorMemberId: ana, now: LATER })).toEqual(missing);
  expect(await balances()).toEqual([6000, -3000, -3000]);
});

function form(fields: Record<string, string | string[]>): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    for (const v of [value].flat()) fd.append(key, v);
  }
  return fd;
}

test("an equal form becomes a bill input", () => {
  const fd = form({
    description: "Groceries",
    total: "56.50",
    paidBy: "a",
    split: "equal",
    sharer: ["a", "b"],
  });
  expect(billInputFromForm(fd)).toEqual({
    ok: true,
    input: { description: "Groceries", totalCents: 5650, paidByMemberId: "a", sharerMemberIds: ["a", "b"] },
  });
});

test("a receipt form carries the subtotal and only the items that were typed", () => {
  const fd = form({
    description: "Dinner",
    total: "$56.50",
    paidBy: "a",
    split: "receipt",
    sharer: ["a", "b"],
    subtotal: "50",
    "own:a": "30",
    "own:b": "",
  });
  expect(billInputFromForm(fd)).toEqual({
    ok: true,
    input: {
      description: "Dinner",
      totalCents: 5650,
      paidByMemberId: "a",
      sharerMemberIds: ["a", "b"],
      receipt: { subtotalCents: 5000, ownCents: { a: 3000 } },
    },
  });
});

test("items typed for someone who was then unticked are dropped", () => {
  const fd = form({
    description: "Dinner",
    total: "56.50",
    paidBy: "a",
    split: "receipt",
    sharer: ["a", "b"],
    subtotal: "50",
    "own:a": "30",
    "own:c": "20",
  });
  const r = billInputFromForm(fd);
  expect(r.ok && r.input.receipt?.ownCents).toEqual({ a: 3000 });
});

test("subtotal and own amounts are ignored when the split is equal", () => {
  const fd = form({
    description: "Groceries",
    total: "56.50",
    paidBy: "a",
    split: "equal",
    sharer: ["a", "b"],
    subtotal: "nonsense",
    "own:a": "30",
  });
  const r = billInputFromForm(fd);
  expect(r.ok && r.input.receipt).toBeUndefined();
});

test("money that does not parse is refused with the field named", () => {
  const ok = { description: "Dinner", total: "56.50", paidBy: "a", split: "receipt", sharer: ["a", "b"] };
  expect(billInputFromForm(form({ ...ok, total: "abc", subtotal: "50" }))).toEqual({
    ok: false,
    error: "The total is not an amount of money.",
  });
  expect(billInputFromForm(form({ ...ok, subtotal: "x" }))).toEqual({
    ok: false,
    error: "The subtotal is not an amount of money.",
  });
  expect(billInputFromForm(form({ ...ok, subtotal: "50", "own:a": "1.999" }))).toEqual({
    ok: false,
    error: "One of the item amounts is not an amount of money.",
  });
});

// The lock must follow what a settle-up actually swept up, not a comparison of two clocks: the
// scheduler and the web pods each read their own time, and a request can wait on the house lock.
test("a bill swept up by a settle-up is locked even if the settle-up's clock read earlier", async () => {
  const billId = await add(groceries(), ana, LATER);
  await settleUpHouse(db, { houseId: house.houseId, now: NOW, reason: "scheduled" });
  expect((await billById(db, billId))?.locked).toBe(true);
  expect(await deleteBill(db, { billId, actorMemberId: ana, now: AFTER })).toEqual({
    ok: false,
    error: LOCKED,
  });
});

test("a bill added after a settle-up is not locked even if its clock read earlier", async () => {
  await settleUpHouse(db, { houseId: house.houseId, now: LATER, reason: "scheduled" });
  const billId = await add(groceries(), ana, NOW);
  expect((await billById(db, billId))?.locked).toBe(false);
  expect(await deleteBill(db, { billId, actorMemberId: ana, now: AFTER })).toEqual({ ok: true });
});

test("a form token reused for a different bill adds that bill too", async () => {
  const first = await add(groceries(), ana, NOW, "t1");
  const second = await add(groceries({ description: "Internet", totalCents: 6000 }), ana, LATER, "t1");
  expect(second).not.toBe(first);
  expect((await houseBills(db, house.houseId)).map((b) => b.description)).toEqual(["Internet", "Groceries"]);
  expect(await balances()).toEqual([10000, -5000, -5000]);
});

test("the same form token in two houses makes a bill in each", async () => {
  const other = await makeHouse(2, { moneyMode: "etransfer" });
  const [m1, m2] = other.members.map((m) => m.memberId);
  await add(groceries(), ana, NOW, "t1");
  const there = await createBill(db, {
    houseId: other.houseId,
    actorMemberId: m1,
    input: groceries({ paidByMemberId: m1, sharerMemberIds: [m1, m2] }),
    clientToken: "t1",
    now: NOW,
  });
  expect(there.ok).toBe(true);
  expect(await count("bills")).toBe(2);
});

test("an edit records the old total, so the feed can show what changed", async () => {
  const billId = await add(groceries());
  await editBill(db, { billId, actorMemberId: ben, input: groceries({ totalCents: 9550 }), now: LATER });
  expect((await recentActivity(db, house.houseId, 1))[0]).toMatchObject({
    kind: "bill_edited",
    data: { billId, description: "Groceries", totalCents: 9550, previousTotalCents: 9000 },
  });
});
