"use client";

import { useRef, useState } from "react";
import { parseReceiptText } from "@/domain/receipt";
import {
  equalPercents,
  formatPercent,
  type ItemLine,
  MAX_ITEMS,
  parseDollars,
  parsePercent,
  splitBill,
} from "@/domain/split";
import { formatCents } from "@/money";
import { SubmitButton } from "./buttons";

type Split = "equal" | "receipt" | "items" | "percent";

/** One line of an item-by-item bill, as typed. */
export type LineValues = { name: string; price: string; who: string[] };

/** What the form starts with. Money is text, exactly as it would be typed. */
export type BillFormValues = {
  description: string;
  total: string;
  paidBy: string;
  split: Split;
  sharers: string[];
  subtotal: string;
  own: Record<string, string>;
  lines: LineValues[];
  pct: Record<string, string>;
};

type Props = {
  /** Active housemates, in rotation order. */
  members: { id: string; name: string }[];
  meId: string;
  initial: BillFormValues;
  action: (fd: FormData) => Promise<void>;
  /** Add: a one-time token so a double tap makes one bill. */
  token?: string;
  /** Edit: the bill being changed. */
  billId?: string;
};

const typedCents = (cents: number) => (cents / 100).toFixed(2);
const typedPercent = (bp: number) => formatPercent(bp).replace("%", "");

/** Makes a receipt photo easier to read: bigger, grey, with stronger contrast. */
async function prepare(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(2, 2000 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const g = canvas.getContext("2d");
  if (!g) return file;
  g.filter = "grayscale(1) contrast(1.6)";
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b ?? file), "image/png"));
}

/**
 * The add-a-bill and edit-a-bill form. As the person types it shows what each housemate would pay,
 * using the same arithmetic the server uses. The server works it out again when the form is sent.
 */
export function BillForm({ members, meId, initial, action, token, billId }: Props) {
  const [total, setTotal] = useState(initial.total);
  const [paidBy, setPaidBy] = useState(initial.paidBy);
  const [split, setSplit] = useState<Split>(initial.split);
  const [sharers, setSharers] = useState(initial.sharers);
  const [subtotal, setSubtotal] = useState(initial.subtotal);
  const [own, setOwn] = useState(initial.own);
  const nextKey = useRef(initial.lines.length);
  const [lines, setLines] = useState(initial.lines.map((l, k) => ({ ...l, key: String(k) })));
  const [pct, setPct] = useState(initial.pct);
  const [scan, setScan] = useState<{ busy: boolean; message: string }>({ busy: false, message: "" });

  const label = (id: string) =>
    id === meId ? "You" : (members.find((m) => m.id === id)?.name ?? "Housemate");
  const ticked = members.filter((m) => sharers.includes(m.id));
  const tickedIds = ticked.map((m) => m.id);
  const toggle = (id: string) =>
    setSharers((now) => (now.includes(id) ? now.filter((s) => s !== id) : [...now, id]));

  const addLine = (line: Partial<LineValues> = {}) => {
    const key = String(nextKey.current++);
    setLines((now) => [...now, { key, name: "", price: "", who: tickedIds, ...line }]);
  };
  const changeLine = (key: string, change: Partial<LineValues>) =>
    setLines((now) => now.map((l) => (l.key === key ? { ...l, ...change } : l)));
  const toggleWho = (key: string, id: string) =>
    setLines((now) =>
      now.map((l) =>
        l.key === key
          ? { ...l, who: l.who.includes(id) ? l.who.filter((w) => w !== id) : [...l.who, id] }
          : l,
      ),
    );

  const choose = (next: Split) => {
    setSplit(next);
    // A fair starting point, so a percentage split is a nudge away rather than blank boxes.
    if (next === "percent" && tickedIds.some((id) => !pct[id])) {
      const even = equalPercents(tickedIds);
      setPct(Object.fromEntries(tickedIds.map((id) => [id, typedPercent(even[id])])));
    }
    if (next === "items" && lines.length === 0) addLine();
  };

  /** Reads a receipt photo on this phone (nothing is uploaded) and fills in the lines to check. */
  async function scanReceipt(file: File) {
    setScan({ busy: true, message: "Getting the reader ready. The first time takes a few seconds." });
    try {
      const { createWorker } = await import("tesseract.js");
      const worker = await createWorker("eng", undefined, {
        logger: (m) => {
          if (m.status === "recognizing text") {
            setScan({ busy: true, message: `Reading the receipt… ${Math.round(m.progress * 100)}%` });
          }
        },
      });
      const { data } = await worker.recognize(await prepare(file));
      await worker.terminate();
      const read = parseReceiptText(data.text);
      if (read.items.length === 0) {
        setScan({
          busy: false,
          message:
            "Could not find any prices in that photo. Try a flatter, brighter shot, or type the items.",
        });
        return;
      }
      setSplit("items");
      nextKey.current = read.items.length;
      setLines(
        read.items.map((item, k) => ({
          key: String(k),
          name: item.name,
          price: typedCents(item.priceCents),
          who: tickedIds,
        })),
      );
      if (read.subtotalCents !== null) setSubtotal(typedCents(read.subtotalCents));
      if (read.totalCents !== null) setTotal(typedCents(read.totalCents));
      const sum = read.items.reduce((s, i) => s + i.priceCents, 0);
      setScan({
        busy: false,
        message: read.itemsMatchSubtotal
          ? `Read ${read.items.length} items, and they add up to the subtotal. Tick who had each one.`
          : `Read ${read.items.length} items adding up to ${formatCents(sum)}${read.subtotalCents !== null ? `, but the receipt says ${formatCents(read.subtotalCents)}` : ""}. Check them against the receipt before saving.`,
      });
    } catch {
      setScan({ busy: false, message: "Could not read that photo here. Type the items instead." });
    }
  }

  // The same steps the server takes, so the preview never promises something the server refuses.
  const totalCents = parseDollars(total);
  const typedSubtotal = parseDollars(subtotal);
  let problem = "";

  const ownCents: Record<string, number> = {};
  if (split === "receipt") {
    for (const m of ticked) {
      const typed = (own[m.id] ?? "").trim();
      if (!typed) continue;
      const cents = parseDollars(typed);
      if (cents === null) problem = "One of the item amounts is not an amount of money.";
      else ownCents[m.id] = cents;
    }
  }

  const itemLines: ItemLine[] = [];
  if (split === "items") {
    for (const l of lines) {
      const cents = parseDollars(l.price);
      if (cents === null) {
        if (l.price.trim()) problem = "One of the item prices is not an amount of money.";
        continue;
      }
      itemLines.push({ priceCents: cents, memberIds: l.who.filter((id) => tickedIds.includes(id)) });
    }
  }
  const itemsSum = itemLines.reduce((s, l) => s + l.priceCents, 0);
  // An item-by-item bill with no subtotal typed takes the items' sum as the subtotal.
  const subtotalCents = split === "items" && !subtotal.trim() && itemsSum > 0 ? itemsSum : typedSubtotal;

  const percentBp: Record<string, number> = {};
  if (split === "percent") {
    for (const id of tickedIds) {
      const bp = parsePercent(pct[id] ?? "");
      if (bp === null) problem = "One of the percentages is not a number from 0 to 100.";
      else percentBp[id] = bp;
    }
  }
  const percentSum = Object.values(percentBp).reduce((s, bp) => s + bp, 0);

  let preview: { memberId: string; cents: number }[] = [];
  if (!problem && total.trim() && totalCents === null) problem = "The total is not an amount of money.";
  else if (
    !problem &&
    split !== "equal" &&
    split !== "percent" &&
    subtotal.trim() &&
    typedSubtotal === null
  ) {
    problem = "The subtotal is not an amount of money.";
  } else if (
    !problem &&
    totalCents !== null &&
    (split === "equal" || split === "percent" || subtotalCents !== null)
  ) {
    const result = splitBill({
      totalCents,
      payerId: paidBy,
      sharerIds: tickedIds,
      receipt: split === "receipt" && subtotalCents !== null ? { subtotalCents, ownCents } : undefined,
      items: split === "items" && subtotalCents !== null ? { subtotalCents, lines: itemLines } : undefined,
      percentBp: split === "percent" ? percentBp : undefined,
    });
    if (result.ok) preview = result.shares;
    else problem = result.error;
  }

  return (
    <form action={action}>
      {token && <input type="hidden" name="token" value={token} />}
      {billId && <input type="hidden" name="billId" value={billId} />}

      <div className="field">
        <label htmlFor="description">What was it?</label>
        <input
          id="description"
          name="description"
          className="input"
          placeholder="Groceries"
          maxLength={60}
          defaultValue={initial.description}
          required
        />
      </div>

      <div className="scan">
        <label className="btn btn-block" aria-disabled={scan.busy}>
          {scan.busy ? "Reading…" : "Scan a receipt"}
          <input
            type="file"
            accept="image/*"
            className="visually-hidden"
            disabled={scan.busy}
            onChange={(e) => {
              const file = e.currentTarget.files?.[0];
              e.currentTarget.value = "";
              if (file) void scanReceipt(file);
            }}
          />
        </label>
        <p className="hint">
          {scan.message ||
            "Read on this phone; the photo is not uploaded. It fills in the items for you to check."}
        </p>
      </div>

      <div className="pair">
        <div className="field">
          <label htmlFor="total">Total paid</label>
          <input
            id="total"
            name="total"
            className="input"
            inputMode="decimal"
            placeholder="56.50"
            value={total}
            onChange={(e) => setTotal(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="paidBy">Paid by</label>
          <select
            id="paidBy"
            name="paidBy"
            className="input"
            value={paidBy}
            onChange={(e) => setPaidBy(e.target.value)}
          >
            {members.map((m) => (
              <option key={m.id} value={m.id}>
                {label(m.id)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset className="field">
        <legend className="legend">Split</legend>
        {(
          [
            ["equal", "Equally.", "Everyone ticked pays the same."],
            ["items", "Item by item.", "Tick who had each line; tax and tip follow what each person had."],
            ["receipt", "By each person's total.", "Type what each person's own items came to."],
            ["percent", "By percentage.", "Like 60/40 for a bigger room."],
          ] as const
        ).map(([value, title, text]) => (
          <label key={value} className="check">
            <input
              type="radio"
              name="split"
              value={value}
              checked={split === value}
              onChange={() => choose(value)}
            />
            <span>
              <strong>{title}</strong> {text}
            </span>
          </label>
        ))}
      </fieldset>

      <fieldset className="field">
        <legend className="legend">Between</legend>
        {members.map((m) => (
          <label key={m.id} className="check">
            <input
              type="checkbox"
              name="sharer"
              value={m.id}
              checked={sharers.includes(m.id)}
              onChange={() => toggle(m.id)}
            />
            <span>{label(m.id)}</span>
          </label>
        ))}
      </fieldset>

      {(split === "receipt" || split === "items") && (
        <div className="field">
          <label htmlFor="subtotal">Subtotal before tax and tip</label>
          {/* Item by item, an empty subtotal means "the items' sum", so that is what is sent. */}
          {split === "items" && (
            <input
              type="hidden"
              name="subtotal"
              value={subtotal.trim() || (itemsSum ? typedCents(itemsSum) : "")}
            />
          )}
          <input
            id="subtotal"
            name={split === "items" ? undefined : "subtotal"}
            className="input"
            inputMode="decimal"
            placeholder={split === "items" && itemsSum ? typedCents(itemsSum) : "50.00"}
            value={subtotal}
            onChange={(e) => setSubtotal(e.target.value)}
            required={split === "receipt"}
          />
          <span className="hint">
            The total above is what was actually paid. The difference is spread by what each person had.
            {split === "items" && !subtotal.trim() ? " Left empty, the items' sum is used." : ""}
          </span>
        </div>
      )}

      {split === "receipt" && (
        <fieldset className="field">
          <legend className="legend">What each person's own items came to, before tax</legend>
          {ticked.map((m) => (
            <div key={m.id} className="row">
              <label htmlFor={`own-${m.id}`}>{label(m.id)}</label>
              <span className="leader" />
              <input
                id={`own-${m.id}`}
                name={`own:${m.id}`}
                className="input own-items"
                inputMode="decimal"
                placeholder="0.00"
                value={own[m.id] ?? ""}
                onChange={(e) => setOwn((now) => ({ ...now, [m.id]: e.target.value }))}
              />
            </div>
          ))}
          <span className="hint">Leave a box empty for someone who only had shared things.</span>
        </fieldset>
      )}

      {split === "items" && (
        <fieldset className="field">
          <legend className="legend">Items, before tax</legend>
          {lines.map((l) => (
            <div key={l.key} className="item-line">
              <input type="hidden" name="line" value={l.key} />
              <div className="pair">
                <input
                  name={`line:${l.key}:name`}
                  className="input"
                  placeholder="Item"
                  maxLength={40}
                  aria-label="Item"
                  value={l.name}
                  onChange={(e) => changeLine(l.key, { name: e.target.value })}
                />
                <input
                  name={`line:${l.key}:price`}
                  className="input own-items"
                  inputMode="decimal"
                  placeholder="0.00"
                  aria-label={`Price of ${l.name || "item"}`}
                  value={l.price}
                  onChange={(e) => changeLine(l.key, { price: e.target.value })}
                />
              </div>
              <div className="who">
                {ticked.map((m) => (
                  <label key={m.id} className="chip">
                    <input
                      type="checkbox"
                      name={`line:${l.key}:who`}
                      value={m.id}
                      checked={l.who.includes(m.id)}
                      onChange={() => toggleWho(l.key, m.id)}
                    />
                    <span>{label(m.id)}</span>
                  </label>
                ))}
                <button
                  type="button"
                  className="btn-quiet"
                  onClick={() => setLines((now) => now.filter((x) => x.key !== l.key))}
                >
                  Remove
                </button>
              </div>
            </div>
          ))}
          {lines.length < MAX_ITEMS && (
            <button type="button" className="btn" onClick={() => addLine()}>
              Add an item
            </button>
          )}
          <span className="hint">
            {itemLines.length > 0
              ? `Items so far: ${formatCents(itemsSum)}. Anything left of the subtotal is shared by everyone ticked.`
              : "Each line is split between whoever is ticked on it."}
          </span>
        </fieldset>
      )}

      {split === "percent" && (
        <fieldset className="field">
          <legend className="legend">Each person's percentage</legend>
          {ticked.map((m) => (
            <div key={m.id} className="row">
              <label htmlFor={`pct-${m.id}`}>{label(m.id)}</label>
              <span className="leader" />
              <input
                id={`pct-${m.id}`}
                name={`pct:${m.id}`}
                className="input own-items"
                inputMode="decimal"
                placeholder="0"
                value={pct[m.id] ?? ""}
                onChange={(e) => setPct((now) => ({ ...now, [m.id]: e.target.value }))}
              />
              <span className="small muted">%</span>
            </div>
          ))}
          <span className="hint">
            {percentSum === 10_000
              ? "Adds up to 100%."
              : `Adds up to ${formatPercent(percentSum)} so far; it needs to be 100%.`}
          </span>
        </fieldset>
      )}

      <section className="receipt" aria-live="polite">
        <p className="title">Each person pays</p>
        {preview.length > 0 ? (
          preview.map((s) => (
            <div key={s.memberId} className="row">
              <span>{label(s.memberId)}</span>
              <span className="leader" />
              <span className="amt">{formatCents(s.cents)}</span>
            </div>
          ))
        ) : (
          <p className="note">
            {problem ||
              (totalCents !== null && split === "receipt"
                ? "Type the subtotal before tax to see the split."
                : "Type the total to see the split.")}
          </p>
        )}
        {preview.length > 0 && (
          <p className="note">
            {label(paidBy)} paid, so {paidBy === meId ? "you are" : `${label(paidBy)} is`} owed the others'
            parts.
          </p>
        )}
      </section>

      {/* Nothing is sent while the split does not work, so a mistake never clears what was typed. */}
      <SubmitButton
        className="btn btn-primary btn-block"
        pendingLabel="Saving…"
        disabled={preview.length === 0}
      >
        {billId ? "Save changes" : "Add bill"}
      </SubmitButton>
    </form>
  );
}
