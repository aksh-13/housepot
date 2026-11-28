import Link from "next/link";
import { notFound } from "next/navigation";
import { devSettleNowAction, fakeInteracEmailAction } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { Flash, PlainMasthead } from "@/components/frame";
import { getDb } from "@/db";
import { inboundDomain } from "@/domain/inbound";
import { ago } from "@/lib/format";
import { formatCents } from "@/money";
import { inboundIsFake } from "@/providers";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * Development only: pretend Interac emails. Each button sends an email through exactly the code a
 * real forwarded email goes through, so the whole settle-up flow can be tried with no email set up.
 */
export default async function InboxPage({ searchParams }: Props) {
  if (!inboundIsFake()) notFound();
  const db = getDb();
  const debts = await db.query<{
    id: string;
    code: string;
    amount_cents: number;
    status: string;
    request_url: string | null;
    from_name: string;
    to_name: string;
    house_name: string;
  }>(
    `select d.id, d.code, d.amount_cents, d.status, d.request_url, coalesce(fu.name, 'Housemate') as from_name,
            coalesce(tu.name, 'Housemate') as to_name, h.name as house_name
     from debts d join houses h on h.id = d.house_id
     join members fm on fm.id = d.from_member_id join users fu on fu.id = fm.user_id
     join members tm on tm.id = d.to_member_id join users tu on tu.id = tm.user_id
     where d.status <> 'paid' order by d.created_at desc limit 30`,
  );
  const emails = await db.query<{
    id: string;
    subject: string;
    outcome: string;
    received_at: Date;
    user_name: string | null;
  }>(
    `select e.id, e.subject, e.outcome, e.received_at, u.name as user_name
     from inbound_emails e left join users u on u.id = e.user_id order by e.received_at desc limit 20`,
  );
  const now = new Date();

  return (
    <main className="shell">
      <PlainMasthead />
      <Flash params={await searchParams} />
      <h1 className="house-name">Pretend Interac</h1>
      <p className="muted small" style={{ marginTop: "var(--space-2)" }}>
        Inbound email is switched off (INBOUND_EMAIL_PROVIDER=fake). These buttons stand in for Interac
        emailing someone's forwarding address (pay-…@{inboundDomain()}). Texts land in the{" "}
        <Link href="/dev/outbox">outbox</Link>.
      </p>

      <section className="section">
        <h2 className="label">Try it without waiting for the 1st</h2>
        <form action={devSettleNowAction}>
          <SubmitButton className="btn btn-block" pendingLabel="Settling…">
            Settle up my house now
          </SubmitButton>
        </form>
      </section>

      <section className="section">
        <h2 className="label">Unpaid debts</h2>
        {debts.rows.length === 0 ? (
          <p className="empty">None. Let a chore expire and claim it, then settle up.</p>
        ) : (
          debts.rows.map((d) => (
            <article key={d.id} className="turn">
              <div className="turn-head">
                <h3>
                  {d.from_name} → {d.to_name}
                </h3>
                <span className="bounty">{formatCents(d.amount_cents)}</span>
              </div>
              <p className="meta">
                {d.house_name} · <span className="code">{d.code}</span> · {d.status}
                {d.request_url ? " · request link saved" : ""}
              </p>
              <div className="actions">
                <form action={fakeInteracEmailAction}>
                  <input type="hidden" name="debtId" value={d.id} />
                  <input type="hidden" name="kind" value="request" />
                  <SubmitButton pendingLabel="Sending…">{d.to_name} requests it</SubmitButton>
                </form>
                <form action={fakeInteracEmailAction}>
                  <input type="hidden" name="debtId" value={d.id} />
                  <input type="hidden" name="kind" value="received" />
                  <SubmitButton pendingLabel="Sending…">{d.from_name} pays, with code</SubmitButton>
                </form>
              </div>
              <div className="actions actions-one">
                <form action={fakeInteracEmailAction}>
                  <input type="hidden" name="debtId" value={d.id} />
                  <input type="hidden" name="kind" value="received" />
                  <input type="hidden" name="withCode" value="no" />
                  <SubmitButton className="btn-quiet" pendingLabel="Sending…">
                    {d.from_name} pays, forgot the code
                  </SubmitButton>
                </form>
              </div>
            </article>
          ))
        )}
      </section>

      <section className="section">
        <h2 className="label">Emails received</h2>
        {emails.rows.length === 0 ? (
          <p className="empty">None yet.</p>
        ) : (
          <ul className="mono-list">
            {emails.rows.map((e) => (
              <li key={e.id}>
                <span className="muted">
                  {e.user_name ?? "unknown address"} · {ago(e.received_at, now)} · {e.outcome}
                </span>
                <br />
                {e.subject}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
