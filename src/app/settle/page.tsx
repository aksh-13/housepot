import Link from "next/link";
import { redirect } from "next/navigation";
import { debtPaidAction } from "@/app/actions";
import { CopyButton, SubmitButton } from "@/components/buttons";
import { Flash, Masthead } from "@/components/frame";
import { LiveRefresh } from "@/components/live-refresh";
import { SquareUpList } from "@/components/square-up";
import { getDb } from "@/db";
import { BANKS, getHouse, memberForUser } from "@/domain/houses";
import { recentInbound } from "@/domain/inbound";
import { type DebtView, debtsForUser, houseSquareUp } from "@/domain/settleup";
import { requireUser } from "@/lib/current";
import { ago, dueLabel } from "@/lib/format";
import { formatCents } from "@/money";
import { inboundIsOff } from "@/providers";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

function Status({ d, now, tz }: { d: DebtView; now: Date; tz: string }) {
  if (d.status === "paid") {
    return (
      <span className="status status-paid">
        Paid {d.paidAt ? ago(d.paidAt, now) : ""}
        {d.paidVia === "email" ? " · checked automatically" : ""}
      </span>
    );
  }
  if (d.dueAt.getTime() < now.getTime()) return <span className="status status-overdue">Overdue</span>;
  if (d.status === "sent") return <span className="status">Sent · waiting for it to land</span>;
  return (
    <span className="status">
      Due {dueLabel(d.dueAt, now, tz).replace(/^(Today|Tomorrow|Yesterday)/, (w) => w.toLowerCase())}
    </span>
  );
}

/** A debt I have to pay: the one-tap Interac request if there is one, otherwise what to type into my bank. */
function YouPay({ d, bank, now, tz }: { d: DebtView; bank: string | null; now: Date; tz: string }) {
  const amount = formatCents(d.amountCents);
  const bankLink = bank ? BANKS[bank] : undefined;
  return (
    <article className="turn turn-mine">
      <div className="turn-head">
        <h3>Pay {d.toName}</h3>
        <span className="bounty owe">{amount}</span>
      </div>
      <Status d={d} now={now} tz={tz} />
      {d.dueAt.getTime() < now.getTime() && (
        <p className="meta">You cannot win chore money until this is paid.</p>
      )}

      {d.requestUrl ? (
        <div className="pay-steps">
          <a className="btn btn-accent btn-block" href={d.requestUrl} target="_blank" rel="noreferrer">
            Pay {d.toName} {amount}
          </a>
          <p className="small muted" style={{ marginTop: "var(--space-2)" }}>
            {d.toName} sent you an Interac request. Pick your bank, sign in, and accept: the amount and
            recipient are already filled in.
          </p>
        </div>
      ) : (
        <ol className="steps pay-steps">
          <li>
            <div>
              <strong>Send {amount} by e-Transfer to</strong>
              {d.toEmail ? (
                <div className="copyline">
                  <span className="value">{d.toEmail}</span>
                  <CopyButton value={d.toEmail} label="Copy" />
                </div>
              ) : (
                <span>{d.toName} has not added an e-Transfer email yet. We texted them to add one.</span>
              )}
            </div>
          </li>
          <li>
            <div>
              <strong>Put this in the message</strong>
              <div className="copyline">
                <span className="value code">{d.code}</span>
                <CopyButton value={d.code} label="Copy" />
              </div>
              <span>
                {inboundIsOff()
                  ? `So ${d.toName} can tell what the payment is for.`
                  : "It lets Housepot see the payment land and mark it paid by itself."}
              </span>
            </div>
          </li>
          <li>
            <div>
              {bankLink ? (
                <a className="btn" href={bankLink.url} target="_blank" rel="noreferrer">
                  Open {bankLink.name}
                </a>
              ) : (
                <span>
                  <Link href="/house/settings">Pick your bank</Link> for a shortcut straight to it.
                </span>
              )}
            </div>
          </li>
        </ol>
      )}

      <div className="actions actions-one">
        <form action={debtPaidAction}>
          <input type="hidden" name="debtId" value={d.id} />
          <SubmitButton className="btn btn-accent" pendingLabel="Saving…">
            I've paid
          </SubmitButton>
        </form>
      </div>
      <p className="small muted" style={{ marginTop: "var(--space-2)" }}>
        Press this once you have sent the e-Transfer. {d.toName} is told, and it is marked as paid.
      </p>
      {!d.requestUrl && !inboundIsOff() && (
        <p className="small muted" style={{ marginTop: "var(--space-3)" }}>
          Or ask {d.toName} to send you an Interac request. If your forwarding is set up, this turns into one
          tap.
        </p>
      )}
    </article>
  );
}

/** A debt someone owes me: how to make it one tap for them, and the manual "it arrived" fallback. */
function YouGet({ d, now, tz }: { d: DebtView; now: Date; tz: string }) {
  const amount = formatCents(d.amountCents);
  return (
    <article className="turn">
      <div className="turn-head">
        <h3>{d.fromName} pays you</h3>
        <span className="bounty">{amount}</span>
      </div>
      <Status d={d} now={now} tz={tz} />
      {inboundIsOff() ? null : d.requestUrl ? (
        <p className="meta">Your Interac request reached Housepot. {d.fromName} can pay in one tap.</p>
      ) : (
        <div className="pay-steps">
          <p className="meta">
            Make it one tap for them: in your bank, send an Interac money request for {amount} to
          </p>
          {d.fromEmail ? (
            <div className="copyline">
              <span className="value">{d.fromEmail}</span>
              <CopyButton value={d.fromEmail} label="Copy" />
            </div>
          ) : (
            <p className="small muted">({d.fromName} has not added an e-Transfer email yet.)</p>
          )}
          <p className="meta">with this in the message:</p>
          <div className="copyline">
            <span className="value code">{d.code}</span>
            <CopyButton value={d.code} label="Copy" />
          </div>
        </div>
      )}
      <div className="actions actions-one">
        <form action={debtPaidAction}>
          <input type="hidden" name="debtId" value={d.id} />
          <SubmitButton className="btn" pendingLabel="Saving…">
            Mark as paid
          </SubmitButton>
        </form>
      </div>
      {!inboundIsOff() && (
        <p className="small muted" style={{ marginTop: "var(--space-2)" }}>
          With forwarding set up you do not need to tap this: Interac's email marks it paid.
        </p>
      )}
    </article>
  );
}

export default async function SettlePage({ searchParams }: Props) {
  const user = await requireUser("/settle");
  const db = getDb();
  const member = await memberForUser(db, user.id);
  const house = member ? await getHouse(db, member.houseId) : null;
  const [debts, inbound, squareUp] = await Promise.all([
    debtsForUser(db, user.id),
    recentInbound(db, user.id, 20),
    house?.moneyMode === "etransfer"
      ? houseSquareUp(db, house.id)
      : Promise.resolve({ lines: [], unclaimedCents: 0 }),
  ]);
  // What I owe or am owed right now that nobody has asked for yet.
  const myLines = squareUp.lines.filter((l) => l.fromMemberId === member?.id || l.toMemberId === member?.id);
  const iStillOwe = myLines.some((l) => l.fromMemberId === member?.id);
  const iAmStillOwed = myLines.some((l) => l.toMemberId === member?.id);
  if (!house && debts.length === 0) redirect("/");
  const tz = house?.tz ?? "America/Toronto";
  const now = new Date();

  const unpaid = debts.filter((d) => d.status !== "paid");
  const iPay = unpaid.filter((d) => d.fromUserId === user.id);
  const iGet = unpaid.filter((d) => d.toUserId === user.id);
  const done = debts.filter((d) => d.status === "paid").slice(0, 10);
  const forwardingWorks = inbound.some((e) => e.kind !== "unknown" || e.outcome === "forwarding_code");

  return (
    <main className="shell">
      {house ? <Masthead current="settle" settle /> : <Masthead />}
      <LiveRefresh />
      <Flash params={await searchParams} />
      <h1 className="house-name">Settle up</h1>
      <p className="muted small" style={{ marginTop: "var(--space-2)" }}>
        Housepot never holds your money. You pay each other by e-Transfer, whenever you like. Nothing is
        requested until one of you asks.
      </p>

      {member && !member.etransferEmail && (
        <section className="callout">
          <h2>Add your e-Transfer email</h2>
          <p>So housemates can pay you, and so Interac requests can reach you.</p>
          <p>
            <Link href="/house/settings">Add it in Settings</Link>
          </p>
        </section>
      )}
      {member && !forwardingWorks && !inboundIsOff() && (
        <section className="callout">
          <h2>Let Housepot check payments for you</h2>
          <p>
            Forward Interac's emails to your private Housepot address, and payments mark themselves paid. Two
            minutes, once. <Link href="/house/settings#auto-check">Set it up</Link>
          </p>
        </section>
      )}

      {member && myLines.length > 0 && (
        <section className="section">
          <h2 className="label">Not asked for yet</h2>
          <SquareUpList lines={myLines} meId={member.id} canAct={member.status === "active"} />
          <p className="small muted" style={{ marginTop: "var(--space-3)" }}>
            This is where you stand right now from bills and chores. Pay or Request turns a line into a
            payment below.
          </p>
        </section>
      )}

      <section className="section">
        <h2 className="label">You pay</h2>
        {iPay.length === 0 ? (
          <p className="empty">
            {iStillOwe
              ? "No payment has been asked of you yet. See above."
              : "Nothing to pay. You are square."}
          </p>
        ) : (
          iPay.map((d) => <YouPay key={d.id} d={d} bank={member?.bank ?? null} now={now} tz={tz} />)
        )}
      </section>

      <section className="section">
        <h2 className="label">You get</h2>
        {iGet.length === 0 ? (
          <p className="empty">
            {iAmStillOwed
              ? "Nobody has been asked to pay you yet. See above."
              : "Nobody owes you anything right now."}
          </p>
        ) : (
          iGet.map((d) => <YouGet key={d.id} d={d} now={now} tz={tz} />)
        )}
      </section>

      {done.length > 0 && (
        <section className="section">
          <h2 className="label">Paid</h2>
          {done.map((d) => (
            <div key={d.id} className="row">
              <span>
                {d.fromUserId === user.id ? `You paid ${d.toName}` : `${d.fromName} paid you`}
                <span className="muted small">
                  {" "}
                  · {d.paidVia === "email" ? "checked automatically" : "marked as paid"}
                </span>
              </span>
              <span className="leader" />
              <span className="amt">{formatCents(d.amountCents)}</span>
            </div>
          ))}
        </section>
      )}
    </main>
  );
}
