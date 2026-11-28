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

/**
 * Lets a waiting turn expire at `now`: moves its deadline just before `now`, then charges the miss.
 * Used where a test needs a chore open to the house without waiting for the real deadline.
 */
export async function expireTurn(turnId: string, now: Date): Promise<{ ok: boolean }> {
  const { missTurn } = await import("@/domain/turns");
  await db.query("update turns set due_at = $2 where id = $1 and status = 'assigned'", [
    turnId,
    new Date(now.getTime() - 60_000),
  ]);
  return missTurn(db, { turnId, now });
}

/**
 * Sends proof for a turn and has every other active housemate approve it, so a test can say "this
 * chore was done" in one line. Returns what the old instant "done" returned: the error if the proof
 * was refused, otherwise what was paid out once the house approved it.
 */
async function approvedByHouse(
  sent: import("@/domain/approvals").SubmitResult,
  memberId: string,
  now: Date,
): Promise<{ ok: true; payoutCents: number } | { ok: false; error: string }> {
  if (!sent.ok) return sent;
  if (sent.decision !== "pending") return { ok: true, payoutCents: sent.payoutCents };
  const { voteOnSubmission } = await import("@/domain/approvals");
  const { activeMembers } = await import("@/domain/houses");
  const found = await db.query<{ house_id: string }>("select house_id from submissions where id = $1", [
    sent.submissionId,
  ]);
  for (const m of await activeMembers(db, found.rows[0].house_id)) {
    if (m.id === memberId) continue;
    const voted = await voteOnSubmission(db, {
      submissionId: sent.submissionId,
      memberId: m.id,
      approve: true,
      now,
    });
    // A vote can fail when something else changed the house at the same moment (a race test).
    if (!voted.ok) return voted;
    if (voted.decision !== "pending") return { ok: true, payoutCents: voted.payoutCents };
  }
  throw new Error("The house never reached a decision.");
}

type ProofArgs = { turnId: string; memberId: string; photoId: string; now: Date };

/** The turn's own person finishes it with one photo, and the house approves it. */
export async function markDone(_db: Db, a: ProofArgs) {
  const { submitDone } = await import("@/domain/approvals");
  const sent = await submitDone(db, { ...a, photoIds: [a.photoId] });
  return approvedByHouse(sent, a.memberId, a.now);
}

/** Someone does an expired chore with one photo, and the house approves it. */
export async function claimBounty(_db: Db, a: ProofArgs) {
  const { submitClaim } = await import("@/domain/approvals");
  const sent = await submitClaim(db, { ...a, photoIds: [a.photoId] });
  return approvedByHouse(sent, a.memberId, a.now);
}

/**
 * Adds a chore the way most tests want it: in use straight away. Once a house has more than one
 * person, a new chore is a proposal, so the rest of the house agrees to it here.
 */
export async function addChore(_db: Db, a: Parameters<typeof import("@/domain/chores").createChore>[1]) {
  const { createChore } = await import("@/domain/chores");
  const { voteOnProposal } = await import("@/domain/worth");
  const { activeMembers } = await import("@/domain/houses");
  const created = await createChore(db, a);
  if (!created.ok || !created.proposed) return created;
  const proposal = await db.query<{ id: string }>(
    "select id from chore_proposals where chore_id = $1 and status = 'open'",
    [created.choreId],
  );
  for (const m of await activeMembers(db, a.houseId)) {
    if (m.id === a.memberId) continue;
    const voted = await voteOnProposal(db, {
      proposalId: proposal.rows[0].id,
      memberId: m.id,
      agree: true,
      now: a.now,
    });
    if (!voted.ok) throw new Error(voted.error);
    if (voted.decision !== "open") break;
  }
  return created;
}
