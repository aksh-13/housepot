import { DateTime } from "luxon";
import type { Db } from "@/db";
import { nextDueAt, type Schedule } from "@/time";
import { logActivity } from "./activity";
import { activeMembers, getHouse, memberById } from "./houses";

export const DEFAULT_SKIP_PRICE_CENTS = 500;
const MIN_SKIP_PRICE_CENTS = 100;
const MAX_SKIP_PRICE_CENTS = 5000;

export type Chore = {
  id: string;
  name: string;
  schedule: Schedule;
  deadlineTime: string;
  skipPriceCents: number;
  archived: boolean;
};

type ChoreRow = {
  id: string;
  name: string;
  schedule_kind: "weekly" | "every_n_days";
  weekday: number | null;
  every_n: number | null;
  anchor_date: string | null;
  deadline_time: string;
  skip_price_cents: number;
  archived: boolean;
};

type Fail = { ok: false; error: string };

function toChore(r: ChoreRow): Chore {
  const schedule: Schedule =
    r.schedule_kind === "weekly"
      ? { kind: "weekly", weekday: r.weekday! }
      : { kind: "every_n_days", n: r.every_n!, anchorDate: r.anchor_date! };
  return {
    id: r.id,
    name: r.name,
    schedule,
    deadlineTime: r.deadline_time,
    skipPriceCents: r.skip_price_cents,
    archived: r.archived,
  };
}

const CHORE_COLUMNS =
  "id, name, schedule_kind, weekday, every_n, anchor_date, deadline_time, skip_price_cents, archived";

/** The house's chores that are still in use, oldest first. */
export async function listChores(db: Db, houseId: string): Promise<Chore[]> {
  const { rows } = await db.query<ChoreRow>(
    `select ${CHORE_COLUMNS} from chores where house_id = $1 and not archived order by created_at, id`,
    [houseId],
  );
  return rows.map(toChore);
}

export async function getChore(db: Db, choreId: string): Promise<(Chore & { houseId: string }) | null> {
  const { rows } = await db.query<ChoreRow & { house_id: string }>(
    `select ${CHORE_COLUMNS}, house_id from chores where id = $1`,
    [choreId],
  );
  return rows[0] ? { ...toChore(rows[0]), houseId: rows[0].house_id } : null;
}

function checkName(name: string): string | null {
  return name.trim() ? null : "Give the chore a name.";
}

function checkTime(time: string): string | null {
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  return m && Number(m[1]) <= 23 && Number(m[2]) <= 59 ? null : "Pick a deadline time, like 21:00.";
}

function checkPrice(cents: number): string | null {
  return Number.isInteger(cents) && cents >= MIN_SKIP_PRICE_CENTS && cents <= MAX_SKIP_PRICE_CENTS
    ? null
    : "The skip price must be between $1 and $50.";
}

function checkSchedule(s: Schedule): string | null {
  if (s.kind === "weekly") {
    return Number.isInteger(s.weekday) && s.weekday >= 1 && s.weekday <= 7 ? null : "Pick a day of the week.";
  }
  if (!Number.isInteger(s.n) || s.n < 1 || s.n > 90) return "Repeat every 1 to 90 days.";
  if (!DateTime.fromISO(s.anchorDate).isValid) return "Pick a start date.";
  return null;
}

function scheduleColumns(s: Schedule): [string, number | null, number | null, string | null] {
  return s.kind === "weekly" ? ["weekly", s.weekday, null, null] : ["every_n_days", null, s.n, s.anchorDate];
}

type CreateArgs = {
  houseId: string;
  memberId: string;
  name: string;
  schedule: Schedule;
  deadlineTime: string;
  skipPriceCents?: number;
  now: Date;
};

export async function createChore(db: Db, a: CreateArgs): Promise<{ ok: true; choreId: string } | Fail> {
  const skipPriceCents = a.skipPriceCents ?? DEFAULT_SKIP_PRICE_CENTS;
  const error =
    checkName(a.name) ?? checkTime(a.deadlineTime) ?? checkPrice(skipPriceCents) ?? checkSchedule(a.schedule);
  if (error) return { ok: false, error };
  const member = await memberById(db, a.memberId);
  if (!member || member.houseId !== a.houseId || member.status !== "active") {
    return { ok: false, error: "Only housemates who have paid in can add chores." };
  }
  const name = a.name.trim().slice(0, 60);
  return db.tx(async (t) => {
    const { rows } = await t.query<{ id: string }>(
      `insert into chores (house_id, name, schedule_kind, weekday, every_n, anchor_date, deadline_time,
         skip_price_cents, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [a.houseId, name, ...scheduleColumns(a.schedule), a.deadlineTime, skipPriceCents, a.now],
    );
    await logActivity(t, {
      houseId: a.houseId,
      memberId: a.memberId,
      kind: "chore_added",
      data: { name },
      now: a.now,
    });
    return { ok: true as const, choreId: rows[0].id };
  });
}

type UpdateArgs = {
  choreId: string;
  memberId: string;
  name?: string;
  schedule?: Schedule;
  deadlineTime?: string;
  skipPriceCents?: number;
  archived?: boolean;
  now: Date;
};

/** Edits a chore. Changing when it is due, or archiving it, cancels the turn that is waiting. */
export async function updateChore(db: Db, a: UpdateArgs): Promise<{ ok: true } | Fail> {
  const chore = await getChore(db, a.choreId);
  const member = await memberById(db, a.memberId);
  if (!chore || !member || member.houseId !== chore.houseId || member.status !== "active") {
    return { ok: false, error: "Only housemates who have paid in can edit chores." };
  }
  const error =
    (a.name !== undefined ? checkName(a.name) : null) ??
    (a.deadlineTime !== undefined ? checkTime(a.deadlineTime) : null) ??
    (a.skipPriceCents !== undefined ? checkPrice(a.skipPriceCents) : null) ??
    (a.schedule !== undefined ? checkSchedule(a.schedule) : null);
  if (error) return { ok: false, error };

  const name = a.name !== undefined ? a.name.trim().slice(0, 60) : chore.name;
  const schedule = a.schedule ?? chore.schedule;
  const deadlineTime = a.deadlineTime ?? chore.deadlineTime;
  const archived = a.archived ?? chore.archived;
  const timingChanged =
    JSON.stringify(schedule) !== JSON.stringify(chore.schedule) || deadlineTime !== chore.deadlineTime;

  await db.tx(async (t) => {
    await t.query(
      `update chores set name = $2, schedule_kind = $3, weekday = $4, every_n = $5, anchor_date = $6,
         deadline_time = $7, skip_price_cents = $8, archived = $9 where id = $1`,
      [
        a.choreId,
        name,
        ...scheduleColumns(schedule),
        deadlineTime,
        a.skipPriceCents ?? chore.skipPriceCents,
        archived,
      ],
    );
    if (timingChanged || (archived && !chore.archived)) {
      await t.query("update turns set status = 'cancelled' where chore_id = $1 and status = 'assigned'", [
        a.choreId,
      ]);
    }
    await logActivity(t, {
      houseId: chore.houseId,
      memberId: a.memberId,
      kind: archived && !chore.archived ? "chore_archived" : "chore_updated",
      data: { name },
      now: a.now,
    });
  });
  return { ok: true };
}

/**
 * Makes sure every chore has a turn waiting, and returns how many were created.
 * The turn goes to the next paid-up housemate after whoever had it last.
 * Cancelled turns do not count, so a pause or an edit does not skip anyone.
 */
export async function ensureTurns(db: Db, houseId: string, now: Date): Promise<number> {
  const house = await getHouse(db, houseId);
  if (!house || house.paused) return 0;
  const members = await activeMembers(db, houseId);
  if (members.length === 0) return 0;

  let created = 0;
  for (const chore of await listChores(db, houseId)) {
    const waiting = await db.query("select 1 from turns where chore_id = $1 and status = 'assigned'", [
      chore.id,
    ]);
    if (waiting.rows.length > 0) continue;

    const last = await db.query<{ due_at: Date; position: number }>(
      `select t.due_at, m.rotation_position as position
       from turns t join members m on m.id = t.assignee_member_id
       where t.chore_id = $1 and t.status <> 'cancelled' order by t.due_at desc limit 1`,
      [chore.id],
    );
    const previous = last.rows[0];
    const after = previous && previous.due_at.getTime() > now.getTime() ? previous.due_at : now;
    const dueAt = nextDueAt(chore.schedule, chore.deadlineTime, house.tz, after);
    const assignee = (previous && members.find((m) => m.rotationPosition > previous.position)) ?? members[0];

    const inserted = await db.query(
      `insert into turns (chore_id, house_id, assignee_member_id, due_at, created_at)
       values ($1, $2, $3, $4, $5)
       on conflict (chore_id) where status = 'assigned' do nothing`,
      [chore.id, houseId, assignee.id, dueAt, now],
    );
    created += inserted.rowCount;
  }
  return created;
}
