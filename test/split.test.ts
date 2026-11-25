import { expect, test } from "vitest";
import { parseDollars, type SplitInput, splitBill } from "@/domain/split";

const split = (i: SplitInput) => {
  const r = splitBill(i);
  if (!r.ok) throw new Error(r.error);
  return Object.fromEntries(r.shares.map((s) => [s.memberId, s.cents]));
};
const refusal = (i: SplitInput) => {
  const r = splitBill(i);
  return r.ok ? "accepted" : r.error;
};
const base: SplitInput = { totalCents: 1000, payerId: "a", sharerIds: ["a", "b", "c"] };

test("an equal split gives the leftover cent to the payer", () => {
  expect(split({ totalCents: 1000, payerId: "a", sharerIds: ["a", "b", "c"] })).toEqual({
    a: 334,
    b: 333,
    c: 333,
  });
});

test("the leftover cent goes to the payer wherever they are in the rotation", () => {
  expect(split({ totalCents: 1000, payerId: "c", sharerIds: ["a", "b", "c"] })).toEqual({
    a: 333,
    b: 333,
    c: 334,
  });
});

test("when the payer is not sharing, leftover cents go in rotation order", () => {
  expect(split({ totalCents: 1000, payerId: "z", sharerIds: ["a", "b", "c"] })).toEqual({
    a: 334,
    b: 333,
    c: 333,
  });
});

test("two leftover cents go to the payer first, then the next person in rotation order", () => {
  expect(split({ totalCents: 1001, payerId: "b", sharerIds: ["a", "b", "c"] })).toEqual({
    a: 334,
    b: 334,
    c: 333,
  });
});

test("a receipt spreads tax in proportion to what each person ordered", () => {
  expect(
    split({
      totalCents: 5650,
      payerId: "sam",
      sharerIds: ["sam", "priya"],
      receipt: { subtotalCents: 5000, ownCents: { sam: 3000, priya: 2000 } },
    }),
  ).toEqual({ sam: 3390, priya: 2260 });
});

test("what is left of the subtotal is shared equally before tax is spread", () => {
  expect(
    split({
      totalCents: 6780,
      payerId: "sam",
      sharerIds: ["sam", "priya", "alex"],
      receipt: { subtotalCents: 6000, ownCents: { sam: 3000, priya: 1000 } },
    }),
  ).toEqual({ sam: 4144, priya: 1883, alex: 753 });
});

test("a total below the subtotal (a discount) uses the same rule", () => {
  expect(
    split({
      totalCents: 4500,
      payerId: "sam",
      sharerIds: ["sam", "priya"],
      receipt: { subtotalCents: 5000, ownCents: { sam: 3000, priya: 2000 } },
    }),
  ).toEqual({ sam: 2700, priya: 1800 });
});

test("someone with no items and nothing shared owes nothing", () => {
  expect(
    split({
      totalCents: 5650,
      payerId: "sam",
      sharerIds: ["sam", "priya", "alex"],
      receipt: { subtotalCents: 5000, ownCents: { sam: 3000, priya: 2000 } },
    }),
  ).toEqual({ sam: 3390, priya: 2260, alex: 0 });
});

test("shares always add up to the total", () => {
  for (let total = 1; total <= 300; total++) {
    for (let n = 1; n <= 5; n++) {
      const sharerIds = ["a", "b", "c", "d", "e"].slice(0, n);
      const r = splitBill({ totalCents: total, payerId: "z", sharerIds });
      if (!r.ok) throw new Error(r.error);
      expect(r.shares.reduce((sum, s) => sum + s.cents, 0)).toBe(total);
      const withReceipt = splitBill({
        totalCents: total,
        payerId: "a",
        sharerIds: [...sharerIds, "y"],
        receipt: { subtotalCents: 997, ownCents: { a: 331, y: 7 } },
      });
      if (!withReceipt.ok) throw new Error(withReceipt.error);
      expect(withReceipt.shares.reduce((sum, s) => sum + s.cents, 0)).toBe(total);
    }
  }
});

test("shares come back in the order the sharers were given", () => {
  const r = splitBill({ totalCents: 900, payerId: "b", sharerIds: ["c", "a", "b"] });
  expect(r.ok && r.shares.map((s) => s.memberId)).toEqual(["c", "a", "b"]);
});

test.each([0, -5, 1.5, 1_000_001, Number.NaN])("a total of %s cents is refused", (totalCents) => {
  expect(refusal({ ...base, totalCents })).toBe("The total must be between $0.01 and $10,000.");
});

test("the largest allowed total is $10,000", () => {
  expect(refusal({ ...base, totalCents: 1_000_000 })).toBe("accepted");
});

test("a bill needs at least one sharer", () => {
  expect(refusal({ ...base, sharerIds: [] })).toBe("Pick at least one person to share it.");
});

test("a sharer cannot be listed twice", () => {
  expect(refusal({ ...base, sharerIds: ["a", "b", "b"] })).toBe("Each person can only be picked once.");
});

test("a bill only the payer shares is refused", () => {
  expect(refusal({ ...base, sharerIds: ["a"] })).toBe("A bill only you share moves no money.");
});

test.each([0, 1_000_001, 10.5])("a subtotal of %s cents is refused", (subtotalCents) => {
  expect(refusal({ ...base, receipt: { subtotalCents, ownCents: {} } })).toBe(
    "The subtotal must be between $0.01 and $10,000.",
  );
});

test.each([-1, 2.5])("an own amount of %s cents is refused", (cents) => {
  expect(refusal({ ...base, receipt: { subtotalCents: 900, ownCents: { a: cents } } })).toBe(
    "Each person's items must be $0 or more.",
  );
});

test("items for someone who is not sharing are refused", () => {
  expect(refusal({ ...base, receipt: { subtotalCents: 900, ownCents: { q: 100 } } })).toBe(
    "Items were entered for someone who is not sharing the bill.",
  );
});

test("items that add up to more than the subtotal are refused", () => {
  expect(refusal({ ...base, receipt: { subtotalCents: 900, ownCents: { a: 500, b: 401 } } })).toBe(
    "The items add up to more than the subtotal.",
  );
});

test.each([
  ["12.5", 1250],
  ["$1,200.50", 120050],
  [" 7 ", 700],
  ["0.01", 1],
  ["56.50", 5650],
  ["$ 20", 2000],
  [".5", 50],
])("parseDollars(%j) is %i cents", (input, cents) => {
  expect(parseDollars(input)).toBe(cents);
});

test.each(["abc", "", "-3", "1.999", "1e3", "$", "1,2,3.4.5", "12.", "Infinity"])(
  "parseDollars(%j) is null",
  (input) => {
    expect(parseDollars(input)).toBeNull();
  },
);
