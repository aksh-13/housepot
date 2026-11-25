import Link from "next/link";
import { notFound } from "next/navigation";
import { fakePayAction } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { PlainMasthead, param } from "@/components/frame";
import { formatCents } from "@/money";
import { paymentsAreFake } from "@/providers";
import { cardHousesOn } from "@/settings";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Development only: stands in for the card processor's checkout page. No real money moves. */
export default async function FakeCheckoutPage({ searchParams }: Props) {
  if (!paymentsAreFake() || !cardHousesOn()) notFound();
  const p = param((await searchParams).p) ?? "";
  let amountCents = 0;
  let fee = 0;
  let saved = false;
  try {
    const { event } = JSON.parse(Buffer.from(p, "base64url").toString());
    amountCents = Number(event.amountCents);
    fee = Number(event.feeCents);
    saved = Boolean(event.customerRef);
  } catch {
    notFound();
  }

  return (
    <main className="shell">
      <PlainMasthead />
      <h1 className="house-name">Pretend checkout</h1>
      <p className="muted small" style={{ marginTop: "var(--space-2)" }}>
        Payments are switched off (PAYMENTS_PROVIDER=fake). No real money moves.
      </p>
      <section className="section">
        <div className="row">
          <span>Into your balance</span>
          <span className="leader" />
          <span className="amt">{formatCents(amountCents)}</span>
        </div>
        <div className="row">
          <span>Card fee</span>
          <span className="leader" />
          <span className="amt">{formatCents(fee)}</span>
        </div>
        <div className="row row-total">
          <span>Total{saved ? " · card will be saved" : ""}</span>
          <span className="leader" />
          <span className="amt">{formatCents(amountCents + fee)}</span>
        </div>
        <form action={fakePayAction} style={{ marginTop: "var(--space-5)" }}>
          <input type="hidden" name="p" value={p} />
          <SubmitButton className="btn btn-accent btn-block" pendingLabel="Paying…">
            Pay {formatCents(amountCents + fee)}
          </SubmitButton>
        </form>
        <p className="small" style={{ marginTop: "var(--space-4)" }}>
          <Link href="/house" className="muted">
            Cancel
          </Link>
        </p>
      </section>
    </main>
  );
}
