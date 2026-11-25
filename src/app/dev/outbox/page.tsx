import { notFound } from "next/navigation";
import { PlainMasthead } from "@/components/frame";
import { getDb } from "@/db";
import { ago } from "@/lib/format";
import { smsIsFake } from "@/providers";

/** Development only: the texts and emails that would have been sent, newest first. */
export default async function OutboxPage() {
  if (!smsIsFake()) notFound();
  const { rows } = await getDb().query<{ id: string; to_phone: string; body: string; created_at: Date }>(
    "select id, to_phone, body, created_at from sms_outbox order by id desc limit 50",
  );
  const now = new Date();
  return (
    <main className="shell">
      <PlainMasthead />
      <h1 className="house-name">Message outbox</h1>
      <p className="muted small" style={{ marginTop: "var(--space-2)" }}>
        Messages are switched off here. These are the texts and emails that would have gone out.
      </p>
      <section className="section">
        {rows.length === 0 ? (
          <p className="empty">No messages yet.</p>
        ) : (
          <ul className="mono-list">
            {rows.map((t) => (
              <li key={t.id}>
                <span className="muted">
                  {t.to_phone} · {ago(t.created_at, now)}
                </span>
                <br />
                {t.body}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
