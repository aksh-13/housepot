import { notFound } from "next/navigation";
import { markSentAction } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { PlainMasthead } from "@/components/frame";
import { getDb } from "@/db";
import { pendingManualPayouts } from "@/domain/settlement";
import { requireUser } from "@/lib/current";
import { ago } from "@/lib/format";
import { isOperator } from "@/lib/operator";
import { formatCents } from "@/money";

/** The operator's to-do list: winnings that have to be sent by e-Transfer. */
export default async function OperatorPage() {
  const user = await requireUser("/operator");
  if (!isOperator(user.phone)) notFound();
  const payouts = await pendingManualPayouts(getDb());
  const now = new Date();

  return (
    <main className="shell">
      <PlainMasthead />
      <h1 className="house-name">e-Transfers to send</h1>
      <section className="section">
        {payouts.length === 0 ? (
          <p className="empty">Nothing to send.</p>
        ) : (
          payouts.map((p) => (
            <article key={p.id} className="turn">
              <div className="turn-head">
                <h3>{p.name}</h3>
                <span className="bounty">{formatCents(p.amountCents)}</span>
              </div>
              <p className="meta">
                {p.phone} · {p.houseName} · {ago(p.createdAt, now)}
              </p>
              <div className="actions actions-one">
                <form action={markSentAction}>
                  <input type="hidden" name="id" value={p.id} />
                  <SubmitButton pendingLabel="Saving…">Mark as sent</SubmitButton>
                </form>
              </div>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
