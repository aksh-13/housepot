import { DateTime } from "luxon";

/** End-of-term dates on which a house pot is cashed out, as [month, day]. */
const TERM_ENDS: [number, number][] = [
  [4, 30],
  [8, 31],
  [12, 20],
];

/** The first term end strictly after today's date in the house's time zone, as "YYYY-MM-DD". */
export function nextTermEnd(now: Date, tz: string): string {
  const today = DateTime.fromJSDate(now, { zone: tz }).startOf("day");
  for (const year of [today.year, today.year + 1]) {
    for (const [month, day] of TERM_ENDS) {
      const candidate = DateTime.fromObject({ year, month, day }, { zone: tz });
      if (candidate > today) return candidate.toISODate()!;
    }
  }
  throw new Error("unreachable: no term end found");
}

/** How often a chore comes round. Weekdays are 1 (Monday) to 7 (Sunday). */
export type Schedule =
  | { kind: "weekly"; weekday: number }
  | { kind: "every_n_days"; n: number; anchorDate: string };

/**
 * The first deadline strictly after `after`. Deadlines are wall-clock times in the house's zone,
 * so 21:00 stays 21:00 across clock changes.
 */
export function nextDueAt(schedule: Schedule, deadlineTime: string, tz: string, after: Date): Date {
  const [hour, minute] = deadlineTime.split(":").map(Number);
  const afterLocal = DateTime.fromJSDate(after, { zone: tz });
  const at = (day: DateTime) => day.set({ hour, minute, second: 0, millisecond: 0 });

  if (schedule.kind === "weekly") {
    for (let offset = 0; offset <= 7; offset++) {
      const candidate = at(afterLocal.startOf("day").plus({ days: offset }));
      if (candidate.weekday === schedule.weekday && candidate.toMillis() > after.getTime()) {
        return candidate.toJSDate();
      }
    }
    throw new Error("unreachable: no weekday match in eight days");
  }

  const anchor = DateTime.fromISO(schedule.anchorDate, { zone: tz }).startOf("day");
  const daysSinceAnchor = Math.floor(afterLocal.startOf("day").diff(anchor, "days").days);
  const steps = Math.max(0, Math.floor(daysSinceAnchor / schedule.n));
  let candidate = at(anchor.plus({ days: steps * schedule.n }));
  while (candidate.toMillis() <= after.getTime()) {
    candidate = at(candidate.startOf("day").plus({ days: schedule.n }));
  }
  return candidate.toJSDate();
}

/** Today's date in the given time zone, as "YYYY-MM-DD". */
export function localDate(now: Date, tz: string): string {
  return DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
}
