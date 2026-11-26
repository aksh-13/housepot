import { DateTime } from "luxon";
import { dollars } from "@/money";

/** "Today, 9:00 PM", "Tomorrow, 9:00 PM", "Thu Nov 19, 9:00 PM" in the house's time zone. */
export function dueLabel(due: Date, now: Date, tz: string): string {
  const d = DateTime.fromJSDate(due, { zone: tz });
  const today = DateTime.fromJSDate(now, { zone: tz }).startOf("day");
  const days = Math.round(d.startOf("day").diff(today, "days").days);
  const day =
    days === 0 ? "Today" : days === 1 ? "Tomorrow" : days === -1 ? "Yesterday" : d.toFormat("ccc LLL d");
  return `${day}, ${d.toFormat("h:mm a")}`;
}

/** "just now", "5m ago", "3h ago", "2d ago" */
export function ago(then: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** "Dec 20, 2026" from "2026-12-20" */
export function dateLabel(isoDate: string): string {
  return DateTime.fromISO(isoDate).toFormat("LLL d, yyyy");
}

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** "Thursdays", "Every 3 days" */
export function scheduleLabel(
  s: { kind: "weekly"; weekday: number } | { kind: "every_n_days"; n: number },
): string {
  if (s.kind === "weekly") return `${WEEKDAYS[s.weekday - 1]}s`;
  return s.n === 1 ? "Every day" : `Every ${s.n} days`;
}

/** "+$5", "−$5" (with a real minus sign), or "" for zero. */
export function signedCents(cents: number): string {
  if (cents === 0) return "";
  return `${cents > 0 ? "+" : "−"}$${dollars(Math.abs(cents))}`;
}

/** "9:00 PM" from "21:00" */
export function timeLabel(hhmm: string): string {
  return DateTime.fromFormat(hhmm, "HH:mm").toFormat("h:mm a");
}
