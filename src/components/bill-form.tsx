"use client";

import { useState } from "react";
import { parseDollars, splitBill } from "@/domain/split";
import { formatCents } from "@/money";
import { SubmitButton } from "./buttons";

/** What the form starts with. Money is text, exactly as it would be typed. */
export type BillFormValues = {
  description: string;
  total: string;
  paidBy: string;
  split: "equal" | "receipt";
  sharers: string[];
  subtotal: string;
  own: Record<string, string>;
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

/**
 * The add-a-bill and edit-a-bill form. As the person types it shows what each housemate would pay,
 * using the same arithmetic the server uses. The server works it out again when the form is sent.
 */
export function BillForm({ members, meId, initial, action, token, billId }: Props) {
  const [total, setTotal] = useState(initial.total);
  const [paidBy, setPaidBy] = useState(initial.paidBy);
  const [split, setSplit] = useState(initial.split);
  const [sharers, setSharers] = useState(initial.sharers);
  const [subtotal, setSubtotal] = useState(initial.subtotal);
  const [own, setOwn] = useState(initial.own);

  const label = (id: string) =>
    id === meId ? "You" : (members.find((m) => m.id === id)?.name ?? "Housemate");
  const ticked = members.filter((m) => sharers.includes(m.id));
  const toggle = (id: string) =>
    setSharers((now) => (now.includes(id) ? now.filter((s) => s !== id) : [...now, id]));

  // The same steps the server takes, so the preview never promises something the server refuses.
  const totalCents = parseDollars(total);
  const subtotalCents = parseDollars(subtotal);
  const ownCents: Record<string, number> = {};
  let ownTypo = false;
  for (const m of ticked) {
    const typed = (own[m.id] ?? "").trim();
    if (!typed) continue;
    const cents = parseDollars(typed);
    if (cents === null) ownTypo = true;
    else ownCents[m.id] = cents;
  }
  const ownSum = Object.values(ownCents).reduce((sum, cents) => sum + cents, 0);
  const sharedCents = subtotalCents === null ? null : subtotalCents - ownSum;

  let preview: { memberId: string; cents: number }[] = [];
  let problem = "";
  if (total.trim() && totalCents === null) problem = "The total is not an amount of money.";
  else if (split === "receipt" && subtotal.trim() && subtotalCents === null) {
    problem = "The subtotal is not an amount of money.";
  } else if (split === "receipt" && ownTypo) problem = "One of the item amounts is not an amount of money.";
  else if (totalCents !== null && (split === "equal" || subtotalCents !== null)) {
    const result = splitBill({
      totalCents,
      payerId: paidBy,
      sharerIds: ticked.map((m) => m.id),
      receipt: split === "receipt" && subtotalCents !== null ? { subtotalCents, ownCents } : undefined,
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
        <label className="check">
          <input
            type="radio"
            name="split"
            value="equal"
            checked={split === "equal"}
            onChange={() => setSplit("equal")}
          />
          <span>
            <strong>Equally.</strong> Everyone ticked pays the same.
          </span>
        </label>
        <label className="check">
          <input
            type="radio"
            name="split"
            value="receipt"
            checked={split === "receipt"}
            onChange={() => setSplit("receipt")}
          />
          <span>
            <strong>By receipt.</strong> Each person pays for what they had, plus their part of the tax and
            tip.
          </span>
        </label>
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

      {split === "receipt" && (
        <>
          <div className="field">
            <label htmlFor="subtotal">Subtotal before tax and tip</label>
            <input
              id="subtotal"
              name="subtotal"
              className="input"
              inputMode="decimal"
              placeholder="50.00"
              value={subtotal}
              onChange={(e) => setSubtotal(e.target.value)}
              required
            />
            <span className="hint">
              The total above is what was actually paid. The difference is spread by what each person had.
            </span>
          </div>
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
            <span className="hint">
              Leave a box empty for someone who only had shared things.
              {sharedCents !== null && sharedCents >= 0 && !ownTypo
                ? ` Shared between everyone ticked: ${formatCents(sharedCents)}.`
                : ""}
            </span>
          </fieldset>
        </>
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
