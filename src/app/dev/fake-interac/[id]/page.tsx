import Link from "next/link";
import { notFound } from "next/navigation";
import { fakeInteracAcceptAction } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { PlainMasthead } from "@/components/frame";
import { getDb } from "@/db";
import { debtById } from "@/domain/settleup";
import { requireUser } from "@/lib/current";
import { formatCents } from "@/money";
import { inboundIsFake } from "@/providers";

type Props = { params: Promise<{ id: string }> };

/**
 * Development only: stands in for the Interac page a money request link opens. In real life the
 * payer picks their bank, signs in, and sees the request already filled in. No real money moves.
 */
export default async function FakeInteracPage({ params }: Props) {
  if (!inboundIsFake()) notFound();
  const user = await requireUser("/settle");
  const debt = await debtById(getDb(), (await params).id);
  if (!debt || debt.fromUserId !== user.id) notFound();

  return (
    <main className="shell">
      <PlainMasthead />
      <h1 className="house-name">Pretend bank</h1>
      <p className="muted small" style={{ marginTop: "var(--space-2)" }}>
        Stands in for your bank's Interac request page. No real money moves.
      </p>
      <section className="section">
        <h2 className="label">Money request</h2>
        <div className="row">
          <span>From</span>
          <span className="leader" />
          <span>{debt.toName}</span>
        </div>
        <div className="row">
          <span>Message</span>
          <span className="leader" />
          <span className="code">Housepot {debt.code}</span>
        </div>
        <div className="row row-total">
          <span>Amount</span>
          <span className="leader" />
          <span className="amt">{formatCents(debt.amountCents)}</span>
        </div>
        {debt.status === "paid" ? (
          <p className="flash flash-notice">Already paid.</p>
        ) : (
          <form action={fakeInteracAcceptAction} style={{ marginTop: "var(--space-5)" }}>
            <input type="hidden" name="debtId" value={debt.id} />
            <SubmitButton className="btn btn-accent btn-block" pendingLabel="Sending…">
              Accept and send {formatCents(debt.amountCents)}
            </SubmitButton>
          </form>
        )}
        <p className="small" style={{ marginTop: "var(--space-4)" }}>
          <Link href="/settle" className="muted">
            Back to Housepot
          </Link>
        </p>
      </section>
    </main>
  );
}
