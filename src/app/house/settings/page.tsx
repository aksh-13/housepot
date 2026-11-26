import {
  autoReloadAction,
  closeVoteAction,
  leaveAction,
  pauseAction,
  renameAction,
  savePayoutAction,
  signOutAction,
} from "@/app/actions";
import { CopyButton, ShareLink, SubmitButton } from "@/components/buttons";
import { Flash, Masthead } from "@/components/frame";
import { getDb } from "@/db";
import { BANKS } from "@/domain/houses";
import { forwardingAddress, recentInbound } from "@/domain/inbound";
import { memberBalance } from "@/domain/ledger";
import { closeVoteCount } from "@/domain/settlement";
import { baseUrl, requireMember } from "@/lib/current";
import { ago, dateLabel } from "@/lib/format";
import { formatCents } from "@/money";
import { inboundIsOff } from "@/providers";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** What happened to an email that reached the forwarding address, in plain words. */
const OUTCOMES: Record<string, string> = {
  paid: "Matched a payment and marked it paid",
  already_paid: "Already marked paid",
  request_saved: "Saved an Interac request for one-tap paying",
  request_without_link: "An Interac request, but with no link we trust",
  amount_short: "Less than the amount owed",
  no_match: "From Interac, but did not match a debt",
  unrecognised: "From Interac, but not an email we understand",
  not_interac: "Not from Interac, ignored",
  not_authenticated: "Failed the signature check, ignored",
  forwarding_code: "Gmail's forwarding confirmation",
};

export default async function SettingsPage({ searchParams }: Props) {
  const { user, member, house } = await requireMember("/house/settings");
  const db = getDb();
  const etransfer = house.moneyMode === "etransfer";
  const [balance, closeVotes, origin, address, inbound, forwarding] = await Promise.all([
    memberBalance(db, member.id),
    closeVoteCount(db, house.id),
    baseUrl(),
    etransfer ? forwardingAddress(db, user.id) : Promise.resolve(""),
    etransfer ? recentInbound(db, user.id, 5) : Promise.resolve([]),
    db.query<{ forwarding_code: string | null }>("select forwarding_code from users where id = $1", [
      user.id,
    ]),
  ]);
  const forwardingCode = forwarding.rows[0]?.forwarding_code;
  const inviteUrl = `${origin}/join/${house.inviteCode}`;
  const votedToClose = closeVotes.votes.includes(member.id);
  const isActive = member.status === "active";
  const now = new Date();

  return (
    <main className="shell">
      <Masthead current="settings" settle={etransfer} />
      <Flash params={await searchParams} />
      <h1 className="house-name">Settings</h1>

      <section className="section">
        <h2 className="label">Invite housemates</h2>
        <div className="invite">
          <input className="input" readOnly value={inviteUrl} aria-label="Invite link" />
          <ShareLink url={inviteUrl} houseName={house.name} />
        </div>
        <p className="small muted" style={{ marginTop: "var(--space-2)" }}>
          {etransfer
            ? "Drop this in the house chat. Nobody pays anything to join: housemates settle up with each other once a month."
            : `Drop this in the house chat. Each person pays the ${formatCents(house.depositCents)} deposit to join the rotation.`}
        </p>
      </section>

      {etransfer && (
        <section className="section stack">
          <h2 className="label">Getting paid</h2>
          <form action={savePayoutAction}>
            <div className="field">
              <label htmlFor="etransferEmail">Your e-Transfer email</label>
              <input
                id="etransferEmail"
                name="etransferEmail"
                type="email"
                className="input"
                autoComplete="email"
                defaultValue={member.etransferEmail ?? ""}
                placeholder="you@example.com"
              />
              <span className="hint">
                The email your bank receives Interac e-Transfers at. Housemates see it when they owe you.
              </span>
            </div>
            <div className="field">
              <label htmlFor="bank">Your bank</label>
              <select id="bank" name="bank" className="input" defaultValue={member.bank ?? ""}>
                <option value="">Not set</option>
                {Object.entries(BANKS).map(([key, b]) => (
                  <option key={key} value={key}>
                    {b.name}
                  </option>
                ))}
              </select>
              <span className="hint">For the "Open my bank" shortcut when you pay someone.</span>
            </div>
            <SubmitButton className="btn btn-primary btn-block" pendingLabel="Saving…">
              Save
            </SubmitButton>
          </form>
        </section>
      )}

      {etransfer && !inboundIsOff() && (
        <section className="section stack" id="auto-check">
          <h2 className="label">Auto-check payments</h2>
          <p className="small muted">
            Forward Interac's emails here and Housepot does the rest: money you receive is marked paid, and
            money requests sent to you become a one-tap Pay button. Only Interac's emails are read.
          </p>
          <div className="copyline">
            <span className="value">{address}</span>
            <CopyButton value={address} label="Copy" />
          </div>
          <details className="editor">
            <summary>
              <span>Set it up in Gmail</span>
              <span className="small muted">2 minutes, on a computer</span>
            </summary>
            <div className="body">
              <ol className="steps">
                <li>
                  <div>
                    <strong>Add the address above as a forwarding address</strong>
                    <span>
                      Gmail → Settings → See all settings → Forwarding and POP/IMAP → Add a forwarding
                      address. Leave forwarding itself turned off.
                    </span>
                  </div>
                </li>
                <li>
                  <div>
                    <strong>Enter Gmail's confirmation code</strong>
                    <span>
                      {forwardingCode
                        ? `It arrived here: ${forwardingCode}`
                        : "Gmail sends it to the address above, and it will show up right here. Reload this page."}
                    </span>
                  </div>
                </li>
                <li>
                  <div>
                    <strong>Make a filter for Interac only</strong>
                    <span>
                      Filters and Blocked Addresses → Create a new filter → From:{" "}
                      <span className="code">interac.ca</span> → Create filter → Forward it to the address
                      above.
                    </span>
                  </div>
                </li>
              </ol>
              <p className="small muted">
                Outlook: Settings → Mail → Rules → add a rule where the sender address includes interac.ca,
                and forward to the address above.
              </p>
            </div>
          </details>
          {inbound.length > 0 && (
            <ul className="mono-list">
              {inbound.map((e) => (
                <li key={e.id}>
                  <span className="muted">{ago(e.receivedAt, now)}</span> · {OUTCOMES[e.outcome] ?? e.outcome}
                  <br />
                  {e.subject}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="section stack">
        <h2 className="label">The house</h2>
        <div className="setting">
          <div>
            <h3>{house.paused ? "Paused" : "Pause the house"}</h3>
            <p>
              {house.paused
                ? "Nothing is assigned or charged right now."
                : "For reading week or the holidays. Nothing is assigned or charged while paused."}
            </p>
          </div>
          <form action={pauseAction}>
            <input type="hidden" name="paused" value={house.paused ? "no" : "yes"} />
            <SubmitButton>{house.paused ? "Resume" : "Pause"}</SubmitButton>
          </form>
        </div>
        {etransfer ? (
          <div className="setting">
            <div>
              <h3>Settle up early</h3>
              <p>
                The house settles up by itself on {dateLabel(house.settlementDate)}. Any housemate can do it
                sooner from the House page: "Settle" next to a person, or "Settle everyone up".
              </p>
            </div>
          </div>
        ) : (
          <div className="setting">
            <div>
              <h3>Cash out early</h3>
              <p>
                Everyone is cashed out on {dateLabel(house.settlementDate)}. To close the pot sooner, more
                than half the house has to agree ({closeVotes.votes.length} of {closeVotes.needed} so far).
              </p>
            </div>
            {isActive && (
              <form action={closeVoteAction}>
                <SubmitButton>{votedToClose ? "Voted" : "Vote"}</SubmitButton>
              </form>
            )}
          </div>
        )}
      </section>

      <section className="section stack">
        <h2 className="label">You</h2>
        {!etransfer && (
          <div className="setting">
            <div>
              <h3>Auto-reload</h3>
              <p>
                {member.customerRef
                  ? `When you hit $0, your saved card is charged to bring you back to ${formatCents(house.depositCents)}.`
                  : "Tick “save my card” the next time you pay in, and it will reload when you hit $0."}
              </p>
            </div>
            {member.customerRef && (
              <form action={autoReloadAction}>
                <input type="hidden" name="on" value={member.autoReload ? "no" : "yes"} />
                <SubmitButton>{member.autoReload ? "Turn off" : "Turn on"}</SubmitButton>
              </form>
            )}
          </div>
        )}
        <div className="setting">
          <div>
            <h3>Put Housepot on your home screen</h3>
            <p>
              It opens like an app, with its own icon. iPhone: tap Share, then "Add to Home Screen". Android:
              open the browser menu, then "Install app" or "Add to Home screen". You sign in once more inside
              it.
            </p>
          </div>
        </div>
        <form action={renameAction}>
          <div className="field">
            <label htmlFor="name">Your name, as housemates see it</label>
            <div className="invite">
              <input
                id="name"
                name="name"
                className="input"
                defaultValue={user.name ?? ""}
                maxLength={40}
                autoComplete="given-name"
                required
              />
              <SubmitButton>Save</SubmitButton>
            </div>
          </div>
        </form>
        <div className="setting">
          <div>
            <h3>Signed in</h3>
            <p>{user.email ?? user.phone}</p>
          </div>
          <form action={signOutAction}>
            <SubmitButton>Sign out</SubmitButton>
          </form>
        </div>
      </section>

      <section className="section">
        <h2 className="label">Leave</h2>
        <details className="editor">
          <summary>
            <span>Leave {house.name}</span>
            <span className="small muted">
              {etransfer ? "Settles the house up" : `Cash out ${formatCents(Math.max(0, balance))}`}
            </span>
          </summary>
          <div className="body">
            <p className="small muted" style={{ marginBottom: "var(--space-4)" }}>
              {etransfer
                ? "The whole house settles up now, so you leave even. Anything you owe or are owed becomes an e-Transfer to send or receive, and stays on your Settle up page after you leave."
                : balance >= 0
                  ? `Your ${formatCents(balance)} goes back to your card. Anything you won on top is sent by e-Transfer within a few days.`
                  : `You owe the house ${formatCents(-balance)}. Leaving writes that off, and your housemates will see it.`}{" "}
              A turn that is waiting on you counts as skipped. This cannot be undone.
            </p>
            <form action={leaveAction}>
              <SubmitButton className="btn btn-danger btn-block" pendingLabel="Leaving…">
                {etransfer ? "Leave and settle up" : "Leave and cash out"}
              </SubmitButton>
            </form>
          </div>
        </details>
      </section>
    </main>
  );
}
