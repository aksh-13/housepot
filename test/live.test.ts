import { expect, test } from "vitest";
import { REFRESH_EVERY_MS, shouldRefresh } from "@/lib/live";

test("a page on screen refreshes itself", () => {
  expect(shouldRefresh({ hidden: false, editing: false, busy: false })).toBe(true);
});

test("a page nobody is looking at does not ask the server for anything", () => {
  expect(shouldRefresh({ hidden: true, editing: false, busy: false })).toBe(false);
});

test("a page is left alone while someone is typing in it or a form is being sent", () => {
  expect(shouldRefresh({ hidden: false, editing: true, busy: false })).toBe(false);
  expect(shouldRefresh({ hidden: false, editing: false, busy: true })).toBe(false);
});

test("pages check for changes every ten seconds", () => {
  expect(REFRESH_EVERY_MS).toBe(10_000);
});
