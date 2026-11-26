import type { Db } from "@/db";
import { formatCents } from "@/money";
import type { Sms } from "@/providers/sms";
import { DISPUTE_WINDOW_MS } from "./disputes";
import { activeMembers } from "./houses";
import { choreBounty } from "./ledger";

export type TurnView = {
  id: string;
  choreId: string;
  choreName: string;
  assigneeMemberId: string;
  assigneeName: string;
  /** Set when the turn belongs to a cleaning team: then it is the team's, not the assignee's. */
  teamId: string | null;
  teamName: string | null;
  dueAt: Date;
  status: "assigned" | "open";
  openedReason: "skip" | "miss" | "dispute" | null;
  skipPriceCents: number;
  /** Money waiting on the chore for whoever does it. */
  bountyCents: number;
};

/** Turns that still need someone: waiting on their assignee, or open to the whole house. */
export async function houseTurns(db: Db, houseId: string): Promise<TurnView[]> {
  const { rows } = await db.query<TurnView>(
    `select t.id, t.chore_id as "choreId", c.name as "choreName",
            t.assignee_member_id as "assigneeMemberId", coalesce(u.name, 'Housemate') as "assigneeName",
            t.team_id as "teamId", tm.name as "teamName",
            t.due_at as "dueAt", t.status, t.opened_reason as "openedReason",
            c.skip_price_cents as "skipPriceCents",
            coalesce((select sum(amount_cents) from ledger_entries le where le.chore_id = c.id), 0)::int as "bountyCents"
     from turns t
     join chores c on c.id = t.chore_id
     join members m on m.id = t.assignee_member_id join users u on u.id = m.user_id
     left join teams tm on tm.id = t.team_id
     where t.house_id = $1 and t.status in ('assigned', 'open')
     order by t.due_at, t.created_at`,
    [houseId],
  );
  return rows;
}

/** Finished turns this member may still dispute: someone else's, inside 24 hours, not yet disputed. */
export async function disputableTurnIds(
  db: Db,
  houseId: string,
  memberId: string,
  now: Date,
): Promise<Set<string>> {
  const { rows } = await db.query<{ id: string }>(
    `select t.id from turns t
       left join disputes d on d.turn_id = t.id and d.completion_at = t.completed_at
     where t.house_id = $1 and t.status in ('done', 'claimed') and d.id is null
       and t.completed_by_member_id <> $2 and t.completed_at >= $3`,
    [houseId, memberId, new Date(now.getTime() - DISPUTE_WINDOW_MS)],
  );
  return new Set(rows.map((r) => r.id));
}

/** Tells the other housemates that a chore is up for grabs. */
export async function textBountyOpen(
  db: Db,
  sms: Sms,
  a: { houseId: string; choreId: string; choreName: string; exceptMemberId: string; link: string },
): Promise<void> {
  const bounty = formatCents(await choreBounty(db, a.choreId));
  for (const m of await activeMembers(db, a.houseId)) {
    if (m.id === a.exceptMemberId) continue;
    await sms
      .send(m.contact, `${a.choreName} is open: +${bounty} to whoever does it, with a photo. ${a.link}`)
      .catch((err) => console.error(`Text to ${m.contact} failed:`, err));
  }
}
