import { DateTime } from "luxon";
import type { Db } from "@/db";
import type { Sms } from "@/providers/sms";
import { localDate } from "@/time";
import { logActivity } from "./activity";
import { activeMembers, getHouse, memberById } from "./houses";

/**
 * Cleaning teams. A house can split into teams that take turns being on duty: one team for a set
 * number of weeks, then the next, round and round. A chore marked for "the team on duty" belongs to
 * that whole team: anyone on it can do it, and a miss is charged to all of them in equal shares.
 * Anyone in the house can also nudge the team on duty ("Garbage is full").
 *
 * A house with no teams works exactly as it did before teams existed.
 */

export type Team = {
  id: string;
  name: string;
  position: number;
  /** Active housemates on the team, in rotation order. */
  memberIds: string[];
  memberNames: string[];
};

export type Nudge = { id: string; label: string; lastSentAt: Date | null };

type Fail = { ok: false; error: string };
const fail = (error: string): Fail => ({ ok: false, error });

export const DEFAULT_TEAM_WEEKS = 2;
export const MAX_TEAM_WEEKS = 8;
const MAX_TEAMS = 8;
const MAX_NUDGES = 8;
const DEFAULT_NUDGE = "Garbage is full";
/** The same nudge goes out at most this often, so the button cannot be used to spam a team. */
export const NUDGE_EVERY_MS = 60 * 60_000;

/** The house's teams in the order they come on duty, each with its active members. */
export async function listTeams(db: Db, houseId: string): Promise<Team[]> {
  const { rows } = await db.query<Team>(
    `select t.id, t.name, t.position,
            coalesce(array_agg(m.id order by m.rotation_position) filter (where m.id is not null), '{}') as "memberIds",
            coalesce(array_agg(coalesce(u.name, 'Housemate') order by m.rotation_position)
                     filter (where m.id is not null), '{}') as "memberNames"
     from teams t
     left join members m on m.team_id = t.id and m.status = 'active'
     left join users u on u.id = m.user_id
     where t.house_id = $1
     group by t.id order by t.position, t.created_at`,
    [houseId],
  );
  return rows;
}

/**
 * Which team is on duty on a given day, as a position in the list, and the last day of its stint.
 * Stints are whole weeks counted from the start date. Before the start date the first team is on.
 */
export function dutyPeriod(a: { teamCount: number; weeks: number; startDate: string; onDate: string }): {
  index: number;
  until: string;
} {
  const start = DateTime.fromISO(a.startDate, { zone: "utc" });
  const day = DateTime.fromISO(a.onDate, { zone: "utc" });
  const stintDays = a.weeks * 7;
  const stint = Math.max(0, Math.floor(day.diff(start, "days").days / stintDays));
  return {
    index: stint % a.teamCount,
    until: start.plus({ days: (stint + 1) * stintDays - 1 }).toISODate() ?? a.onDate,
  };
}

/** The team on duty at a moment, and the last day of its stint. Null when the house has no teams. */
export async function teamOnDuty(
  db: Db,
  houseId: string,
  at: Date,
): Promise<{ team: Team; until: string } | null> {
  const house = await getHouse(db, houseId);
  if (!house?.teamWeeks || !house.teamStart) return null;
  const teams = await listTeams(db, houseId);
  if (teams.length === 0) return null;
  const { index, until } = dutyPeriod({
    teamCount: teams.length,
    weeks: house.teamWeeks,
    startDate: house.teamStart,
    onDate: localDate(at, house.tz),
  });
  return { team: teams[index], until };
}

async function activeIn(db: Db, houseId: string, memberId: string): Promise<boolean> {
  const member = await memberById(db, memberId);
  return Boolean(member && member.houseId === houseId && member.status === "active");
}

/** Turns waiting on a team are cancelled when teams change; the next ensureTurns hands them out again. */
async function cancelTeamTurns(t: Db, houseId: string): Promise<void> {
  await t.query(
    "update turns set status = 'cancelled' where house_id = $1 and status = 'assigned' and team_id is not null",
    [houseId],
  );
}

/**
 * Adds a team called "Team A", "Team B" and so on. The first team switches teams on for the house:
 * two weeks each, starting this week's Monday, with a "Garbage is full" nudge to begin with.
 */
export async function addTeam(
  db: Db,
  a: { houseId: string; memberId: string; now: Date },
): Promise<{ ok: true; teamId: string } | Fail> {
  if (!(await activeIn(db, a.houseId, a.memberId))) return fail("Only housemates can do that.");
  const house = await getHouse(db, a.houseId);
  if (!house) return fail("Only housemates can do that.");
  return db.tx(async (t) => {
    await t.query("select pg_advisory_xact_lock(hashtext($1))", [`house:${a.houseId}`]);
    const existing = await t.query<{ name: string; position: number }>(
      "select name, position from teams where house_id = $1 order by position",
      [a.houseId],
    );
    if (existing.rows.length >= MAX_TEAMS) return fail(`A house can have up to ${MAX_TEAMS} teams.`);
    const taken = new Set(existing.rows.map((r) => r.name));
    const letter =
      "ABCDEFGH".split("").find((l) => !taken.has(`Team ${l}`)) ?? String(existing.rows.length + 1);
    const name = `Team ${letter}`;
    const position = existing.rows.length ? Math.max(...existing.rows.map((r) => r.position)) + 1 : 0;
    const inserted = await t.query<{ id: string }>(
      "insert into teams (house_id, name, position, created_at) values ($1, $2, $3, $4) returning id",
      [a.houseId, name, position, a.now],
    );
    if (existing.rows.length === 0) {
      const monday = DateTime.fromISO(localDate(a.now, house.tz)).startOf("week").toISODate();
      await t.query(
        "update houses set team_weeks = coalesce(team_weeks, $2), team_start = coalesce(team_start, $3) where id = $1",
        [a.houseId, DEFAULT_TEAM_WEEKS, monday],
      );
      const nudges = await t.query("select 1 from nudges where house_id = $1", [a.houseId]);
      if (nudges.rows.length === 0) {
        await t.query("insert into nudges (house_id, label, created_at) values ($1, $2, $3)", [
          a.houseId,
          DEFAULT_NUDGE,
          a.now,
        ]);
      }
    }
    await cancelTeamTurns(t, a.houseId);
    await logActivity(t, {
      houseId: a.houseId,
      memberId: a.memberId,
      kind: "team_added",
      data: { name },
      now: a.now,
    });
    return { ok: true as const, teamId: inserted.rows[0].id };
  });
}

/** Removes a team. Its people are on no team until someone puts them on one. */
export async function removeTeam(
  db: Db,
  a: { teamId: string; memberId: string; now: Date },
): Promise<{ ok: true } | Fail> {
  const found = await db.query<{ house_id: string; name: string }>(
    "select house_id, name from teams where id::text = $1",
    [a.teamId],
  );
  const team = found.rows[0];
  if (!team || !(await activeIn(db, team.house_id, a.memberId))) return fail("Only housemates can do that.");
  return db.tx(async (t) => {
    await t.query("select pg_advisory_xact_lock(hashtext($1))", [`house:${team.house_id}`]);
    await cancelTeamTurns(t, team.house_id);
    await t.query("delete from teams where id = $1", [a.teamId]);
    await logActivity(t, {
      houseId: team.house_id,
      memberId: a.memberId,
      kind: "team_removed",
      data: { name: team.name },
      now: a.now,
    });
    return { ok: true as const };
  });
}

type SaveArgs = {
  houseId: string;
  memberId: string;
  /** How many weeks each team is on duty. */
  weeks: number;
  /** The day the first team's first stint began, as YYYY-MM-DD. */
  startDate: string;
  /** New names, by team id. Teams not listed keep their name. */
  names: Record<string, string>;
  /** Which team each housemate is on, by member id. Null takes them off every team. */
  assignments: Record<string, string | null>;
  now: Date;
};

/** Saves the rotation and who is on which team, in one go. */
export async function saveTeams(db: Db, a: SaveArgs): Promise<{ ok: true } | Fail> {
  if (!(await activeIn(db, a.houseId, a.memberId))) return fail("Only housemates can do that.");
  if (!Number.isInteger(a.weeks) || a.weeks < 1 || a.weeks > MAX_TEAM_WEEKS) {
    return fail(`Each team can be on duty for 1 to ${MAX_TEAM_WEEKS} weeks.`);
  }
  if (!DateTime.fromISO(a.startDate).isValid) return fail("Pick the day the first team started.");
  return db.tx(async (t) => {
    await t.query("select pg_advisory_xact_lock(hashtext($1))", [`house:${a.houseId}`]);
    const teams = await t.query<{ id: string }>("select id from teams where house_id = $1", [a.houseId]);
    const teamIds = new Set(teams.rows.map((r) => r.id));
    const members = new Set((await activeMembers(t, a.houseId)).map((m) => m.id));
    for (const [memberId, teamId] of Object.entries(a.assignments)) {
      if (!members.has(memberId) || (teamId !== null && !teamIds.has(teamId))) {
        return fail("Those teams and housemates do not belong to this house.");
      }
    }
    for (const [teamId, name] of Object.entries(a.names)) {
      if (!teamIds.has(teamId)) return fail("Those teams and housemates do not belong to this house.");
      if (!name.trim()) return fail("Give every team a name.");
    }
    await t.query("update houses set team_weeks = $2, team_start = $3 where id = $1", [
      a.houseId,
      a.weeks,
      a.startDate,
    ]);
    for (const [teamId, name] of Object.entries(a.names)) {
      await t.query("update teams set name = $2 where id = $1", [teamId, name.trim().slice(0, 30)]);
    }
    for (const [memberId, teamId] of Object.entries(a.assignments)) {
      await t.query("update members set team_id = $2 where id = $1", [memberId, teamId]);
    }
    await cancelTeamTurns(t, a.houseId);
    await logActivity(t, { houseId: a.houseId, memberId: a.memberId, kind: "teams_saved", now: a.now });
    return { ok: true as const };
  });
}

export async function listNudges(db: Db, houseId: string): Promise<Nudge[]> {
  const { rows } = await db.query<Nudge>(
    `select id, label, last_sent_at as "lastSentAt" from nudges where house_id = $1 order by created_at, id`,
    [houseId],
  );
  return rows;
}

export async function addNudge(
  db: Db,
  a: { houseId: string; memberId: string; label: string; now: Date },
): Promise<{ ok: true } | Fail> {
  if (!(await activeIn(db, a.houseId, a.memberId))) return fail("Only housemates can do that.");
  const label = a.label.trim().slice(0, 40);
  if (!label) return fail("Say what the nudge is.");
  if ((await listNudges(db, a.houseId)).length >= MAX_NUDGES)
    return fail(`A house can have up to ${MAX_NUDGES} nudges.`);
  await db.query("insert into nudges (house_id, label, created_at) values ($1, $2, $3)", [
    a.houseId,
    label,
    a.now,
  ]);
  return { ok: true };
}

export async function removeNudge(
  db: Db,
  a: { nudgeId: string; memberId: string },
): Promise<{ ok: true } | Fail> {
  const found = await db.query<{ house_id: string }>("select house_id from nudges where id::text = $1", [
    a.nudgeId,
  ]);
  if (!found.rows[0] || !(await activeIn(db, found.rows[0].house_id, a.memberId))) {
    return fail("Only housemates can do that.");
  }
  await db.query("delete from nudges where id = $1", [a.nudgeId]);
  return { ok: true };
}

/**
 * Tells everyone on the team on duty, except the person pressing the button. Any housemate can send
 * one, on duty or not. Each nudge goes out at most once an hour.
 */
export async function sendNudge(
  db: Db,
  sms: Sms,
  a: { nudgeId: string; memberId: string; now: Date; link: string },
): Promise<{ ok: true; sentTo: number; teamName: string } | Fail> {
  const found = await db.query<{ house_id: string; label: string }>(
    "select house_id, label from nudges where id::text = $1",
    [a.nudgeId],
  );
  const nudge = found.rows[0];
  const sender = await memberById(db, a.memberId);
  if (!nudge || !sender || sender.houseId !== nudge.house_id || sender.status !== "active") {
    return fail("Only housemates can do that.");
  }
  const duty = await teamOnDuty(db, nudge.house_id, a.now);
  if (!duty) return fail("Set up teams first, so there is a team to tell.");

  // Claimed in the database before anything is sent, so two taps at once send it once.
  const claimed = await db.query(
    "update nudges set last_sent_at = $2 where id = $1 and (last_sent_at is null or last_sent_at <= $3)",
    [a.nudgeId, a.now, new Date(a.now.getTime() - NUDGE_EVERY_MS)],
  );
  if (claimed.rowCount === 0) return fail("That was already sent in the last hour.");

  const until = DateTime.fromISO(duty.until).toFormat("LLL d");
  const body = `${nudge.label}. ${sender.name} flagged it, and ${duty.team.name} is on duty until ${until}. ${a.link}`;
  const everyone = await activeMembers(db, nudge.house_id);
  const recipients = everyone.filter((m) => duty.team.memberIds.includes(m.id) && m.id !== a.memberId);
  for (const m of recipients) {
    // One failed email must not stop the rest of the team hearing about it.
    await sms.send(m.contact, body).catch((err) => console.error(`Nudge to ${m.contact} failed:`, err));
  }
  await logActivity(db, {
    houseId: nudge.house_id,
    memberId: a.memberId,
    kind: "nudged",
    data: { label: nudge.label, teamName: duty.team.name },
    now: a.now,
  });
  return { ok: true, sentTo: recipients.length, teamName: duty.team.name };
}

/**
 * Someone puts themselves on a team, for instance when they join a house that already has teams.
 * Team chores already handed out stay where they are; the next ones count them in.
 */
export async function joinTeam(
  db: Db,
  a: { memberId: string; teamId: string; now: Date },
): Promise<{ ok: true } | Fail> {
  const member = await memberById(db, a.memberId);
  if (!member || member.status === "left") return fail("Only housemates can do that.");
  const team = await db.query<{ name: string }>(
    "select name from teams where id::text = $1 and house_id = $2",
    [a.teamId, member.houseId],
  );
  if (!team.rows[0]) return fail("Pick one of this house's teams.");
  await db.query("update members set team_id = $2 where id = $1", [a.memberId, a.teamId]);
  await logActivity(db, {
    houseId: member.houseId,
    memberId: a.memberId,
    kind: "joined_team",
    data: { name: team.rows[0].name },
    now: a.now,
  });
  return { ok: true };
}

/**
 * Sets a new house up with teams from the start: this many teams, each on duty for this many
 * weeks, with the person setting it up on the first one. Everyone else is placed as they join.
 */
export async function setUpTeams(
  db: Db,
  a: { houseId: string; memberId: string; count: number; weeks: number; now: Date },
): Promise<{ ok: true } | Fail> {
  const count = Math.min(Math.max(Math.trunc(a.count), 2), MAX_TEAMS);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const added = await addTeam(db, { houseId: a.houseId, memberId: a.memberId, now: a.now });
    if (!added.ok) return added;
    ids.push(added.teamId);
  }
  const house = await getHouse(db, a.houseId);
  if (!house?.teamStart) return fail("Could not start the teams.");
  return saveTeams(db, {
    houseId: a.houseId,
    memberId: a.memberId,
    weeks: a.weeks,
    startDate: house.teamStart,
    names: {},
    assignments: { [a.memberId]: ids[0] },
    now: a.now,
  });
}
