import type { Db } from "@/db";
import { logActivity } from "./activity";
import { activeMembers, memberById } from "./houses";

/**
 * What a chore is worth only matters when it expires: that is what the person it expired on pays,
 * and what whoever does it instead takes. So the house agrees on it.
 *
 * While the house has nobody in it but the person setting it up, they decide. After that, a new
 * chore, or a new worth for one already in use, is a proposal. It takes effect once more than half
 * of the other housemates agree, and lapses if that has not happened within three days. A new chore
 * gets no turns until it is agreed; an existing one keeps its old worth in the meantime.
 */

export const PROPOSAL_WINDOW_MS = 3 * 24 * 60 * 60_000;

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

export type ProposalDecision = "accepted" | "rejected" | "open";

type ProposalRow = {
  id: string;
  house_id: string;
  chore_id: string;
  proposed_by_member_id: string;
  kind: "new" | "worth";
  worth_cents: number;
  status: string;
  created_at: Date;
};

/** True when the house has someone to ask besides this member. */
export async function needsAgreement(db: Db, houseId: string, memberId: string): Promise<boolean> {
  return (await activeMembers(db, houseId)).some((m) => m.id !== memberId);
}

/** Opens a proposal. Must run inside the transaction that created or edited the chore. */
export async function propose(
  t: Db,
  a: {
    houseId: string;
    choreId: string;
    choreName: string;
    memberId: string;
    kind: "new" | "worth";
    worthCents: number;
    /** For a new chore that starts with someone other than the person proposing it. */
    firstName?: string;
    now: Date;
  },
): Promise<string | null> {
  const { rows } = await t.query<{ id: string }>(
    `insert into chore_proposals (house_id, chore_id, proposed_by_member_id, kind, worth_cents, created_at)
     values ($1, $2, $3, $4, $5, $6) on conflict (chore_id) where status = 'open' do nothing returning id`,
    [a.houseId, a.choreId, a.memberId, a.kind, a.worthCents, a.now],
  );
  if (!rows[0]) return null;
  await logActivity(t, {
    houseId: a.houseId,
    memberId: a.memberId,
    kind: "worth_proposed",
    data: {
      name: a.choreName,
      worthCents: a.worthCents,
      proposal: a.kind,
      ...(a.firstName ? { firstName: a.firstName } : {}),
    },
    now: a.now,
  });
  return rows[0].id;
}

async function tally(t: Db, p: ProposalRow) {
  const voters = (await activeMembers(t, p.house_id))
    .filter((m) => m.id !== p.proposed_by_member_id)
    .map((m) => m.id);
  const { rows } = await t.query<{ member_id: string; agree: boolean }>(
    "select member_id, agree from proposal_votes where proposal_id = $1",
    [p.id],
  );
  const votes: Record<string, boolean> = {};
  for (const r of rows) if (voters.includes(r.member_id)) votes[r.member_id] = r.agree;
  const yes = Object.values(votes).filter(Boolean).length;
  const no = Object.values(votes).filter((v) => !v).length;
  return { voters, votes, yes, no, needed: Math.floor(voters.length / 2) + 1 };
}

/** Accepts, rejects or lapses the proposal if it can be decided now. Chore and proposal locked. */
async function decideIfReady(t: Db, p: ProposalRow, now: Date): Promise<ProposalDecision> {
  const { voters, yes, no, needed } = await tally(t, p);
  let status: "accepted" | "rejected" | "lapsed" | null = null;
  if (voters.length === 0 || yes >= needed) status = "accepted";
  else if (no >= needed) status = "rejected";
  else if (now.getTime() - p.created_at.getTime() >= PROPOSAL_WINDOW_MS) status = "lapsed";
  if (!status) return "open";

  await t.query("update chore_proposals set status = $2, decided_at = $3 where id = $1", [p.id, status, now]);
  const chore = await t.query<{ name: string }>("select name from chores where id = $1", [p.chore_id]);
  if (status === "accepted") {
    if (p.kind === "new") {
      await t.query("update chores set agreed_at = $2, skip_price_cents = $3 where id = $1", [
        p.chore_id,
        now,
        p.worth_cents,
      ]);
    } else {
      await t.query("update chores set skip_price_cents = $2 where id = $1", [p.chore_id, p.worth_cents]);
    }
  } else if (p.kind === "new") {
    // A chore the house did not agree to never starts.
    await t.query("update chores set archived = true where id = $1", [p.chore_id]);
  }
  await logActivity(t, {
    houseId: p.house_id,
    memberId: p.proposed_by_member_id,
    kind: status === "accepted" ? "worth_agreed" : "worth_not_agreed",
    data: { name: chore.rows[0]?.name, worthCents: p.worth_cents, proposal: p.kind, outcome: status },
    now,
  });
  return status === "accepted" ? "accepted" : "rejected";
}

async function lockProposal(t: Db, id: string): Promise<ProposalRow | null> {
  const found = await t.query<{ chore_id: string }>(
    "select chore_id from chore_proposals where id::text = $1",
    [id],
  );
  if (!found.rows[0]) return null;
  await t.query("select id from chores where id = $1 for update", [found.rows[0].chore_id]);
  const { rows } = await t.query<ProposalRow>(
    `select id, house_id, chore_id, proposed_by_member_id, kind, worth_cents, status, created_at
     from chore_proposals where id = $1 for update`,
    [id],
  );
  return rows[0] ?? null;
}

export async function voteOnProposal(
  db: Db,
  a: { proposalId: string; memberId: string; agree: boolean; now: Date },
): Promise<{ ok: true; decision: ProposalDecision } | Fail> {
  return db.tx(async (t) => {
    const p = await lockProposal(t, a.proposalId);
    if (!p || p.status !== "open") return fail("The house has already decided this one.");
    const member = await memberById(t, a.memberId);
    if (!member || member.houseId !== p.house_id || member.status !== "active") {
      return fail("Only housemates can vote.");
    }
    if (p.proposed_by_member_id === a.memberId)
      return fail("You proposed this, so your yes is already counted.");
    await t.query(
      `insert into proposal_votes (proposal_id, member_id, agree, voted_at) values ($1, $2, $3, $4)
       on conflict (proposal_id, member_id) do update set agree = excluded.agree, voted_at = excluded.voted_at`,
      [p.id, a.memberId, a.agree, a.now],
    );
    return { ok: true as const, decision: await decideIfReady(t, p, a.now) };
  });
}

/** For the tick: lapses proposals whose three days are up, or accepts them if nobody is left to ask. */
export async function closeOldProposals(db: Db, houseId: string, now: Date): Promise<number> {
  const { rows } = await db.query<{ id: string }>(
    "select id from chore_proposals where house_id = $1 and status = 'open'",
    [houseId],
  );
  let closed = 0;
  for (const row of rows) {
    const decided = await db.tx(async (t) => {
      const p = await lockProposal(t, row.id);
      return p && p.status === "open" ? (await decideIfReady(t, p, now)) !== "open" : false;
    });
    if (decided) closed += 1;
  }
  return closed;
}

export type ProposalView = {
  id: string;
  choreId: string;
  choreName: string;
  kind: "new" | "worth";
  worthCents: number;
  /** The chore's worth now, for a change to an existing chore. */
  currentCents: number;
  proposedById: string;
  proposedByName: string;
  yes: number;
  no: number;
  needed: number;
  votes: Record<string, boolean>;
  closesAt: Date;
};

export async function openProposals(db: Db, houseId: string): Promise<ProposalView[]> {
  const { rows } = await db.query<
    ProposalRow & { chore_name: string; current_cents: number; proposer_name: string }
  >(
    `select p.id, p.house_id, p.chore_id, p.proposed_by_member_id, p.kind, p.worth_cents, p.status, p.created_at,
            c.name as chore_name, c.skip_price_cents as current_cents, coalesce(u.name, 'Housemate') as proposer_name
     from chore_proposals p
     join chores c on c.id = p.chore_id
     join members m on m.id = p.proposed_by_member_id join users u on u.id = m.user_id
     where p.house_id = $1 and p.status = 'open'
     order by p.created_at`,
    [houseId],
  );
  const views: ProposalView[] = [];
  for (const r of rows) {
    const { votes, yes, no, needed } = await tally(db, r);
    views.push({
      id: r.id,
      choreId: r.chore_id,
      choreName: r.chore_name,
      kind: r.kind,
      worthCents: r.worth_cents,
      currentCents: r.current_cents,
      proposedById: r.proposed_by_member_id,
      proposedByName: r.proposer_name,
      yes,
      no,
      needed,
      votes,
      closesAt: new Date(r.created_at.getTime() + PROPOSAL_WINDOW_MS),
    });
  }
  return views;
}
