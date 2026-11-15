import { autoReloadAction, closeVoteAction, leaveAction, pauseAction, signOutAction } from "@/app/actions";
import { ShareLink, SubmitButton } from "@/components/buttons";
import { Flash, Masthead } from "@/components/frame";
import { getDb } from "@/db";
import { memberBalance } from "@/domain/ledger";
import { closeVoteCount } from "@/domain/settlement";
import { baseUrl, requireMember } from "@/lib/current";
import { dateLabel } from "@/lib/format";
import { formatCents } from "@/money";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function SettingsPage({ searchParams }: Props) {
  const { user, member, house } = await requireMember("/house/settings");
  const db = getDb();
  const [balance, closeVotes, origin] = await Promise.all([
    memberBalance(db, member.id),
    closeVoteCount(db, house.id),
    baseUrl(),
  ]);
  const inviteUrl = `${origin}/join/${house.inviteCode}`;
  const votedToClose = closeVotes.votes.includes(member.id);
  const isActive = member.status === "active";

  return (
    <main className="shell">
      <Masthead current="settings" />
      <Flash params={await searchParams} />
      <h1 className="house-name">Settings</h1>

      <section className="section">
        <h2 className="label">Invite housemates</h2>
        <div className="invite">
          <input className="input" readOnly value={inviteUrl} aria-label="Invite link" />
          <ShareLink url={inviteUrl} houseName={house.name} />
        </div>
        <p className="small muted" style={{ marginTop: "var(--space-2)" }}>
          Drop this in the house chat. Each person pays the {formatCents(house.depositCents)} deposit to join
          the rotation.
        </p>
      </section>

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
        <div className="setting">
          <div>
            <h3>Cash out early</h3>
            <p>
              Everyone is cashed out on {dateLabel(house.settlementDate)}. To close the pot sooner, more than
              half the house has to agree ({closeVotes.votes.length} of {closeVotes.needed} so far).
            </p>
          </div>
          {isActive && (
            <form action={closeVoteAction}>
              <SubmitButton>{votedToClose ? "Voted" : "Vote"}</SubmitButton>
            </form>
          )}
        </div>
      </section>

      <section className="section stack">
        <h2 className="label">You</h2>
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
        <div className="setting">
          <div>
            <h3>Signed in as {user.name ?? "you"}</h3>
            <p>{user.phone}</p>
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
            <span className="small muted">Cash out {formatCents(Math.max(0, balance))}</span>
          </summary>
          <div className="body">
            <p className="small muted" style={{ marginBottom: "var(--space-4)" }}>
              {balance >= 0
                ? `Your ${formatCents(balance)} goes back to your card. Anything you won on top is sent by e-Transfer within a few days.`
                : `You owe the house ${formatCents(-balance)}. Leaving writes that off, and your housemates will see it.`}{" "}
              Your turns go to the next person. This cannot be undone.
            </p>
            <form action={leaveAction}>
              <SubmitButton className="btn btn-danger btn-block" pendingLabel="Leaving…">
                Leave and cash out
              </SubmitButton>
            </form>
          </div>
        </details>
      </section>
    </main>
  );
}
