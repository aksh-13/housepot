import { expect, test } from "vitest";
import { parseReceiptText } from "@/domain/receipt";

const GROCERY = `
FRESHCO #4521
123 KING ST W HAMILTON ON
905-555-0101
11/27/2026  18:42
0006038385 2% MILK 4L          5.99
0004011 BANANAS
  1.32 kg @ $1.52/kg           2.01
0068700 CHEERIOS 525G          4.49 H
COUPON CHEERIOS               -1.00
0057800 DISH SOAP              3.29 H
SUBTOTAL                      14.78
HST 13%                        0.87
TOTAL                         15.65
DEBIT                         15.65
CHANGE                         0.00
THANK YOU FOR SHOPPING
`;

test("a grocery receipt: items, a coupon, tax, and nothing below the total", () => {
  const r = parseReceiptText(GROCERY);
  expect(r.items).toEqual([
    { name: "2% Milk 4l", priceCents: 599 },
    { name: "Bananas", priceCents: 201 },
    { name: "Cheerios 525g", priceCents: 349 },
    { name: "Dish Soap", priceCents: 329 },
  ]);
  expect(r).toMatchObject({ subtotalCents: 1478, taxCents: 87, tipCents: 0, totalCents: 1565 });
  expect(r.itemsMatchSubtotal).toBe(true);
});

test("a restaurant bill with a tip, and no subtotal printed", () => {
  const r = parseReceiptText(`
THE PEARL
Table 4   Server: Jo
1 Pad Thai              16.50
1 Green Curry           17.25
2 Spring Rolls           9.00
GST                      2.14
TIP                      6.00
AMOUNT DUE              50.89
VISA ************1234   50.89
`);
  expect(r.items.map((i) => i.priceCents)).toEqual([1650, 1725, 900]);
  expect(r).toMatchObject({ taxCents: 214, tipCents: 600, totalCents: 5089, subtotalCents: 4275 });
  expect(r.itemsMatchSubtotal).toBe(true);
});

test("common misreadings are fixed: O for zero, commas for points, a stray flag", () => {
  const r = parseReceiptText(`
EGGS DOZEN        4,5O
BREAD             3.2O *
SUB-TOTAL         7,70
TAX               O.00
TOTAL             7.70
`);
  expect(r.items).toEqual([
    { name: "Eggs Dozen", priceCents: 450 },
    { name: "Bread", priceCents: 320 },
  ]);
  expect(r.subtotalCents).toBe(770);
  expect(r.itemsMatchSubtotal).toBe(true);
});

test("a misread line shows up as a mismatch, so the person knows to check", () => {
  const r = parseReceiptText(`
APPLES            3.99
ORANGES           S.49
SUBTOTAL          9.48
`);
  // "S.49" reads as 5.49 once S is taken for 5, so this one is fixed too.
  expect(r.items.map((i) => i.priceCents)).toEqual([399, 549]);
  expect(r.itemsMatchSubtotal).toBe(true);

  const missed = parseReceiptText(`
APPLES            3.99
ORANGES           ~~~
SUBTOTAL          9.48
`);
  expect(missed.items.map((i) => i.priceCents)).toEqual([399]);
  expect(missed.itemsMatchSubtotal).toBe(false);
});

test("text with no prices in it gives nothing, not nonsense", () => {
  expect(parseReceiptText("a blurry photo of a cat\nno numbers here")).toEqual({
    items: [],
    subtotalCents: null,
    taxCents: 0,
    tipCents: 0,
    totalCents: null,
    itemsMatchSubtotal: false,
  });
});
