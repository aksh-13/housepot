import { expect, test } from "vitest";
import { nextDueAt } from "@/time";

const TZ = "America/Toronto";
const THURSDAY = { kind: "weekly", weekday: 4 } as const;
const iso = (d: Date) => d.toISOString();

test("weekly Thursday 21:00, asked on Wednesday noon, is that Thursday at 21:00 Toronto time", () => {
  const after = new Date("2026-11-11T17:00:00Z"); // Wed 12:00 EST
  expect(iso(nextDueAt(THURSDAY, "21:00", TZ, after))).toBe("2026-11-13T02:00:00.000Z");
});

test("asked on Thursday before the deadline, it is the same day", () => {
  const after = new Date("2026-11-12T20:00:00Z"); // Thu 15:00 EST
  expect(iso(nextDueAt(THURSDAY, "21:00", TZ, after))).toBe("2026-11-13T02:00:00.000Z");
});

test("asked exactly at the deadline, it is the following Thursday", () => {
  const after = new Date("2026-11-13T02:00:00Z");
  expect(iso(nextDueAt(THURSDAY, "21:00", TZ, after))).toBe("2026-11-20T02:00:00.000Z");
});

test("the deadline stays at 21:00 local when the clocks go forward in March", () => {
  const after = new Date("2026-03-06T02:00:00Z"); // Thu Mar 5, 21:00 EST
  expect(iso(nextDueAt(THURSDAY, "21:00", TZ, after))).toBe("2026-03-13T01:00:00.000Z"); // 21:00 EDT
});

test("the deadline stays at 21:00 local when the clocks go back in November", () => {
  const after = new Date("2026-10-30T01:00:00Z"); // Thu Oct 29, 21:00 EDT
  expect(iso(nextDueAt(THURSDAY, "21:00", TZ, after))).toBe("2026-11-06T02:00:00.000Z"); // 21:00 EST
});

test("every 3 days counts from the anchor date", () => {
  const s = { kind: "every_n_days", n: 3, anchorDate: "2026-11-10" } as const;
  // Nov 10, 13, 16 ... at 08:00 EST = 13:00Z
  expect(iso(nextDueAt(s, "08:00", TZ, new Date("2026-11-10T12:00:00Z")))).toBe("2026-11-10T13:00:00.000Z");
  expect(iso(nextDueAt(s, "08:00", TZ, new Date("2026-11-10T13:00:00Z")))).toBe("2026-11-13T13:00:00.000Z");
  expect(iso(nextDueAt(s, "08:00", TZ, new Date("2026-11-14T18:00:00Z")))).toBe("2026-11-16T13:00:00.000Z");
});

test("an anchor in the future is the first deadline", () => {
  const s = { kind: "every_n_days", n: 7, anchorDate: "2026-12-01" } as const;
  expect(iso(nextDueAt(s, "08:00", TZ, new Date("2026-11-14T18:00:00Z")))).toBe("2026-12-01T13:00:00.000Z");
});

test("every day gives tomorrow once today's deadline has passed", () => {
  const s = { kind: "every_n_days", n: 1, anchorDate: "2026-01-01" } as const;
  expect(iso(nextDueAt(s, "23:30", TZ, new Date("2026-11-15T04:30:00Z")))).toBe("2026-11-16T04:30:00.000Z");
});
