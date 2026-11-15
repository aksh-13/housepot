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

/** Today's date in the given time zone, as "YYYY-MM-DD". */
export function localDate(now: Date, tz: string): string {
  return DateTime.fromJSDate(now, { zone: tz }).toISODate()!;
}
