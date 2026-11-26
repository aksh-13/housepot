import Link from "next/link";
import {
  claimAction,
  disputeAction,
  doneAction,
  payAction,
  settleNowAction,
  settleWithAction,
  skipAction,
  voteAction,
} from "@/app/actions";
import { PhotoSubmit, SubmitButton } from "@/components/buttons";
import { Flash, Masthead } from "@/components/frame";
import { InstallHint } from "@/components/install-hint";
import { getDb } from "@/db";
import { type ActivityItem, recentActivity } from "@/domain/activity";
import { listChores } from "@/domain/chores";
import { openDisputes } from "@/domain/disputes";
import { houseBalances } from "@/domain/ledger";
import { debtsForUser, houseSquareUp } from "@/domain/settleup";
import { disputableTurnIds, houseTurns, type TurnView } from "@/domain/views";
import { requireMember } from "@/lib/current";
import { ago, dateLabel, dueLabel, signedCents } from "@/lib/format";
import { feeCents, formatCents } from "@/money";
import { inboundIsOff } from "@/providers";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** One line of the activity feed, in plain words, with the money that moved (if any). */
function describe(item: ActivityItem, meId: string): { text: string; cents?: number } {
  const who = item.memberId === meId ? "You" : (item.memberName ?? "Someone");
  const chore = item.data.choreName ?? "a chore";
  const amount = Number(item.data.amountCents ?? 0);
  const payout = Number(item.data.payoutCents ?? 0);
  switch (item.kind) {
    case "house_created":
      return { text: `${who} started the house` };
    case "joined":
      return { text: `${who} joined` };
    case "deposit_paid":
      return { text: `${who} paid the deposit`, cents: amount };
    case "topped_up":
      return { text: `${who} topped up`, cents: amount };
    case "auto_reloaded":
      return { text: `${who} reloaded automatically`, cents: amount };
    case "auto_reload_failed":
      return { text: `${who === "You" ? "Your" : `${who}'s`} card was declined` };
    case "chore_added":
      return { text: `${who} added ${item.data.name}` };
    case "chore_updated":
      return { text: `${who} edited ${item.data.name}` };
    case "chore_archived":
      return { text: `${who} removed ${item.data.name}` };
    case "done":
      return { text: `${who} did ${chore}`, cents: payout || undefined };
    case "claimed":
      return { text: `${who} did ${chore} and took the bounty`, cents: payout || undefined };
    case "skipped":
      return { text: `${who} skipped ${chore}`, cents: -amount };
    case "missed":
      return { text: `${who} missed ${chore}`, cents: -amount };
    case "dispute_raised":
      return { text: `${who} disputed ${chore}` };
    case "dispute_passed":
      return { text: `The house agreed ${chore} was not done`, cents: amount ? -amount : undefined };
    case "paused":
      return { text: `${who} paused the house` };
    case "resumed":
      return { text: `${who} resumed the house` };
    case "left":
      return { text: `${who} left the house` };
    case "cashed_out":
      return { text: `${who} cashed out` };
    case "settled":
      return { text: "The pot was cashed out and restarted" };
    case "bill_added":
      return { text: `${who} added ${item.data.description} (${formatCents(Number(item.data.totalCents))})` };
    case "bill_edited":
      return { text: `${who} changed ${item.data.description}` };
    case "bill_deleted":
      return { text: `${who} deleted ${item.data.description}` };
    case "settled_up": {
      const n = Number(item.data.payments ?? 0);
      return {
        text:
          n === 0
            ? "The house settled up: everyone was even"
            : `The house settled up: ${n} e-Transfer${n === 1 ? "" : "s"} to send`,
      };
    }
    case "settled_pair":
      return {
        text: `${item.data.fromName} and ${item.data.toName} settled up: ${formatCents(amount)} to send`,
      };
    case "debt_sent":
      return { text: `${who} sent ${item.data.toName} ${formatCents(amount)}` };
    case "debt_paid":
      return {
        text: `${who} paid ${item.data.toName} ${formatCents(amount)}${item.data.via === "email" ? " (checked automatically)" : ""}`,
      };
    default:
      return { text: item.kind };
  }
}

/** "Today, 9:00 PM" reads as "today, 9:00 PM" in the middle of a sentence. Weekday names keep their capital. */
const midSentence = (label: string) =>
  label.replace(/^(Today|Tomorrow|Yesterday)/, (word) => word.toLowerCase());

function openReason(turn: TurnView, meId: string): string {
  const mine = turn.assigneeMemberId === meId;
  if (turn.openedReason === "skip") return mine ? "You skipped this." : `${turn.assigneeName} skipped it.`;
  if (turn.openedReason === "dispute") return "The house said it was not done.";
  return mine ? "You missed this." : `${turn.assigneeName} missed it.`;
}

export default async function HousePage({ searchParams }: Props) {
  const { user, member, house } = await requireMember();
  const db = getDb();
  const now = new Date();
  const etransfer = house.moneyMode === "etransfer";
  const [balances, turns, disputes, activity, disputable, chores, myDebts, squareUp] = await Promise.all([
    houseBalances(db, house.id),
    houseTurns(db, house.id),
    openDisputes(db, house.id, now),
    recentActivity(db, house.id, 30),
    disputableTurnIds(db, house.id, member.id, now),
    listChores(db, house.id),
    etransfer ? debtsForUser(db, user.id) : Promise.resolve([]),
    etransfer ? houseSquareUp(db, house.id) : Promise.resolve({ lines: [], unclaimedCents: 0 }),
  ]);
  // The viewer's own payments first: what they pay, what they get, then everyone else's.
  const involvesMe = (l: { fromMemberId: string; toMemberId: string }) =>
    l.fromMemberId === member.id || l.toMemberId === member.id;
  const squareLines = [...squareUp.lines].sort((x, y) => Number(involvesMe(y)) - Number(involvesMe(x)));
  const iOwe = myDebts.filter((d) => d.status !== "paid" && d.fromUserId === user.id);
  const owedToMe = myDebts.filter((d) => d.status !== "paid" && d.toUserId === user.id);
  const overdue = iOwe.some((d) => d.dueAt.getTime() < now.getTime());

  const me = balances.find((b) => b.memberId === member.id);
  const myBalance = me?.balanceCents ?? 0;
  const due = Math.max(0, house.depositCents - myBalance);
  const isActive = member.status === "active";
  const mine = turns.filter((t) => t.status === "assigned" && t.assigneeMemberId === member.id);
  const open = turns.filter((t) => t.status === "open");
  const others = turns.filter((t) => t.status === "assigned" && t.assigneeMemberId !== member.id);
  const potTotal = balances.reduce((sum, b) => sum + b.balanceCents, 0);

  return (
    <main className="shell">
      <Masthead current="house" settle={etransfer} />
      <Flash params={await searchParams} />
      <h1 className="house-name">{house.name}</h1>
      <InstallHint />
      {etransfer && isActive && (
        <p style={{ marginTop: "var(--space-4)" }}>
          <Link href="/bills/new" className="btn btn-primary btn-block">
            Add a bill
          </Link>
        </p>
      )}

      {iOwe.length > 0 && (
        <section className="callout">
          <h2>You owe {formatCents(iOwe.reduce((s, d) => s + d.amountCents, 0))} from the last settle-up.</h2>
          <p>
            {overdue
              ? "It is overdue: you cannot win chore money until it is paid."
              : inboundIsOff()
                ? "Pay by e-Transfer, then mark it as paid."
                : "Pay by e-Transfer. Housepot spots it landing and marks it paid."}
          </p>
          <p>
            <Link href="/settle" className="btn btn-accent btn-block">
              Settle up
            </Link>
          </p>
        </section>
      )}
      {iOwe.length === 0 && owedToMe.length > 0 && (
        <p className="flash flash-notice" role="status">
          {owedToMe.length === 1 ? `${owedToMe[0].fromName} owes` : `${owedToMe.length} housemates owe`} you{" "}
          {formatCents(owedToMe.reduce((s, d) => s + d.amountCents, 0))}. <Link href="/settle">See it</Link>
        </p>
      )}
      {etransfer && !member.etransferEmail && (
        <p className="flash flash-notice" role="status">
          Add your e-Transfer email so housemates can pay you. <Link href="/house/settings">Add it</Link>
        </p>
      )}

      {/* Asked loudly only when it blocks you: not yet paid in, or nothing left. Otherwise a quiet link in the pot. */}
      {!etransfer && due > 0 && (!isActive || myBalance <= 0) && (
        <section className="callout">
          <h2>
            {isActive
              ? `You are at ${formatCents(myBalance)}. Top up ${formatCents(due)}.`
              : `Pay your ${formatCents(due)} deposit to join the rotation.`}
          </h2>
          <p>
            Plus a {formatCents(feeCents(due))} card fee.{" "}
            {isActive ? "" : "You get back whatever is left at the end of term."}
          </p>
          <form action={payAction}>
            <label className="check">
              <input type="checkbox" name="saveCard" defaultChecked={member.autoReload} />
              <span>Save my card and reload automatically if I hit $0</span>
            </label>
            <SubmitButton className="btn btn-accent btn-block" pendingLabel="Opening checkout…">
              {isActive ? `Top up ${formatCents(due)}` : `Pay ${formatCents(due)} deposit`}
            </SubmitButton>
          </form>
        </section>
      )}

      {house.paused && (
        <p className="flash flash-notice" role="status">
          The house is paused. Nothing is assigned or charged until someone resumes it in Settings.
        </p>
      )}

      {isActive && (
        <section className="section">
          <h2 className="label">Your turn</h2>
          {mine.length === 0 ? (
            <p className="empty">
              {chores.length === 0 ? (
                <>
                  No chores yet. <Link href="/house/chores">Add the first one.</Link>
                </>
              ) : (
                "Nothing due. You are clear."
              )}
            </p>
          ) : (
            mine.map((turn) => (
              <article key={turn.id} className="turn turn-mine">
                <div className="turn-head">
                  <h3>{turn.choreName}</h3>
                  {turn.bountyCents > 0 && <span className="bounty">+{formatCents(turn.bountyCents)}</span>}
                </div>
                <p className="meta">
                  Due {midSentence(dueLabel(turn.dueAt, now, house.tz))}
                  {turn.bountyCents > 0 && " · a bounty is waiting if you do it on time"}
                </p>
                <div className="actions">
                  <form action={doneAction}>
                    <input type="hidden" name="turnId" value={turn.id} />
                    <PhotoSubmit label="Done" />
                  </form>
                  <form action={skipAction}>
                    <input type="hidden" name="turnId" value={turn.id} />
                    <SubmitButton pendingLabel="Skipping…">
                      {etransfer
                        ? `Skip for ${formatCents(turn.skipPriceCents)}`
                        : `Pay ${formatCents(turn.skipPriceCents)} to skip`}
                    </SubmitButton>
                  </form>
                </div>
              </article>
            ))
          )}
        </section>
      )}

      {open.length > 0 && (
        <section className="section">
          <h2 className="label">Up for grabs</h2>
          {open.map((turn) => (
            <article key={turn.id} className="turn">
              <div className="turn-head">
                <h3>{turn.choreName}</h3>
                <span className="bounty">+{formatCents(turn.bountyCents)}</span>
              </div>
              <p className="meta">
                {openReason(turn, member.id)} First to do it, with a photo, takes the money.
              </p>
              {isActive && (
                <div className="actions actions-one">
                  <form action={claimAction}>
                    <input type="hidden" name="turnId" value={turn.id} />
                    <PhotoSubmit
                      label={`Claim ${formatCents(turn.bountyCents)} with a photo`}
                      className="btn btn-accent"
                    />
                  </form>
                </div>
              )}
            </article>
          ))}
        </section>
      )}

      {disputes.length > 0 && (
        <section className="section">
          <h2 className="label">Disputes</h2>
          {disputes.map((d) => {
            const myVote = d.votes[member.id];
            const canVote = isActive && d.accusedMemberId !== member.id;
            return (
              <article key={d.id} className="turn">
                <div className="turn-head">
                  <h3>{d.choreName}</h3>
                  <span className="num small muted">
                    {d.agreeCount} of {d.needed}
                  </span>
                </div>
                <p className="meta">
                  {d.raisedByName} says {d.accusedMemberId === member.id ? "you" : d.accusedName} did not
                  really do it. Voting closes {midSentence(dueLabel(d.closesAt, now, house.tz))}.
                  {d.photoId && (
                    <>
                      {" "}
                      <a href={`/api/photos/${d.photoId}`} target="_blank" rel="noreferrer">
                        See the photo
                      </a>
                    </>
                  )}
                </p>
                {canVote && (
                  <div className="actions">
                    <form action={voteAction}>
                      <input type="hidden" name="disputeId" value={d.id} />
                      <input type="hidden" name="agree" value="yes" />
                      <SubmitButton className={myVote === true ? "btn btn-primary" : "btn"}>
                        Not done
                      </SubmitButton>
                    </form>
                    <form action={voteAction}>
                      <input type="hidden" name="disputeId" value={d.id} />
                      <input type="hidden" name="agree" value="no" />
                      <SubmitButton className={myVote === false ? "btn btn-primary" : "btn"}>
                        It was done
                      </SubmitButton>
                    </form>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {others.length > 0 && (
        <section className="section">
          <h2 className="label">Coming up</h2>
          {others.map((turn) => (
            <div key={turn.id} className="row">
              <span>
                {turn.choreName} <span className="muted">· {turn.assigneeName}</span>
              </span>
              <span className="leader" />
              <span className="small muted">{dueLabel(turn.dueAt, now, house.tz)}</span>
            </div>
          ))}
        </section>
      )}

      {etransfer && (
        <section className="section">
          <h2 className="label">To square up</h2>
          {squareLines.length === 0 ? (
            <p className="empty">Everyone is square.</p>
          ) : (
            squareLines.map((l) => (
              <div key={`${l.fromMemberId}-${l.toMemberId}`} className="row">
                <span>
                  {l.fromMemberId === member.id
                    ? `You pay ${l.toName}`
                    : l.toMemberId === member.id
                      ? `${l.fromName} pays you`
                      : `${l.fromName} pays ${l.toName}`}
                </span>
                <span className="leader" />
                <span
                  className={`amt ${l.fromMemberId === member.id ? "loss" : l.toMemberId === member.id ? "gain" : ""}`}
                >
                  {formatCents(l.amountCents)}
                </span>
                {isActive && involvesMe(l) && (
                  <form action={settleWithAction} className="row-action">
                    <input
                      type="hidden"
                      name="otherMemberId"
                      value={l.fromMemberId === member.id ? l.toMemberId : l.fromMemberId}
                    />
                    <SubmitButton className="btn btn-small" pendingLabel="…">
                      Settle
                    </SubmitButton>
                  </form>
                )}
              </div>
            ))
          )}
          {squareUp.unclaimedCents > 0 && (
            <p className="small muted" style={{ marginTop: "var(--space-3)" }}>
              {formatCents(squareUp.unclaimedCents)} is waiting on unclaimed chores and is not counted here.
            </p>
          )}
          {squareLines.length > 0 && isActive && (
            <>
              <form action={settleNowAction} style={{ marginTop: "var(--space-4)" }}>
                <SubmitButton className="btn btn-accent btn-block" pendingLabel="Settling up…">
                  Settle everyone up
                </SubmitButton>
              </form>
              <p className="small muted" style={{ marginTop: "var(--space-3)" }}>
                "Settle" on a line is just between you and that person. "Settle everyone up" turns the whole
                list into payments and locks the bills behind it; otherwise that happens by itself on{" "}
                {dateLabel(house.settlementDate)}.
              </p>
            </>
          )}
        </section>
      )}

      {etransfer ? (
        <section className="section">
          <h2 className="label">This month</h2>
          {balances.map((b) => (
            <div key={b.memberId} className="row">
              <span>
                {b.name}
                {b.memberId === member.id && <span className="muted"> (you)</span>}
              </span>
              <span className="leader" />
              <span className={`amt ${b.balanceCents > 0 ? "gain" : b.balanceCents < 0 ? "loss" : ""}`}>
                {b.balanceCents === 0 ? "$0" : signedCents(b.balanceCents)}
              </span>
            </div>
          ))}
          <p className="small muted" style={{ marginTop: "var(--space-3)" }}>
            Nobody pays in. On {dateLabel(house.settlementDate)} the house settles up: whoever is down sends
            whoever is up an e-Transfer.
          </p>
        </section>
      ) : (
        <section className="section">
          <h2 className="label">The pot</h2>
          {balances.map((b) => {
            const delta = b.balanceCents - house.depositCents;
            return (
              <div key={b.memberId} className="row">
                <span>
                  {b.name}
                  {b.memberId === member.id && <span className="muted"> (you)</span>}
                </span>
                <span className="leader" />
                {b.status === "pending" ? (
                  <span className="small muted">not paid in</span>
                ) : (
                  <>
                    <span className={`amt${b.balanceCents < 0 ? " loss" : ""}`}>
                      {formatCents(b.balanceCents)}
                    </span>
                    <span className={`delta ${delta > 0 ? "gain" : "loss"}`}>{signedCents(delta)}</span>
                  </>
                )}
              </div>
            );
          })}
          <div className="row row-total">
            <span>Held for the house</span>
            <span className="leader" />
            <span className="amt">{formatCents(potTotal)}</span>
            <span className="delta" />
          </div>
          <p className="small muted" style={{ marginTop: "var(--space-3)" }}>
            Everyone is cashed out on {dateLabel(house.settlementDate)}.
          </p>
          {isActive && due > 0 && myBalance > 0 && (
            <form action={payAction}>
              <SubmitButton className="btn-quiet" pendingLabel="Opening checkout…">
                Top up {formatCents(due)} to get back to {formatCents(house.depositCents)}
              </SubmitButton>
            </form>
          )}
        </section>
      )}

      <section className="section">
        <h2 className="label">Activity</h2>
        {activity.length === 0 ? (
          <p className="empty">Nothing yet.</p>
        ) : (
          <ul className="feed">
            {activity.map((item) => {
              const line = describe(item, member.id);
              const turnId = item.data.turnId as string | undefined;
              const canDispute =
                isActive &&
                turnId &&
                (item.kind === "done" || item.kind === "claimed") &&
                disputable.has(turnId);
              return (
                <li key={item.id}>
                  <div>
                    <p className="what">
                      {line.text}
                      {line.cents ? (
                        <span className={`num ${line.cents > 0 ? "gain" : "loss"}`}>
                          {" "}
                          {signedCents(line.cents)}
                        </span>
                      ) : null}
                    </p>
                    <p className="when">{ago(item.createdAt, now)}</p>
                    {canDispute && (
                      <form action={disputeAction}>
                        <input type="hidden" name="turnId" value={turnId} />
                        <SubmitButton className="btn-quiet" pendingLabel="Raising…">
                          Not actually done? Dispute
                        </SubmitButton>
                      </form>
                    )}
                  </div>
                  {item.data.photoId && (
                    <a
                      href={`/api/photos/${item.data.photoId}`}
                      target="_blank"
                      rel="noreferrer"
                      className="side"
                    >
                      {/* biome-ignore lint/performance/noImgElement: proof photos are private and served by our own route */}
                      <img
                        className="thumb"
                        src={`/api/photos/${item.data.photoId}`}
                        alt={`Proof photo: ${line.text}`}
                        loading="lazy"
                      />
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </main>
  );
}
