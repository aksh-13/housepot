import Link from "next/link";
import {
  approvalVoteAction,
  assignTurnAction,
  claimAction,
  doneAction,
  nudgeAction,
  payAction,
  settleNowAction,
  swapAnswerAction,
  swapCancelAction,
  swapRequestAction,
  worthVoteAction,
} from "@/app/actions";
import { PhotoSubmit, ShareLink, SubmitButton } from "@/components/buttons";
import { Flash, Masthead } from "@/components/frame";
import { InstallHint } from "@/components/install-hint";
import { LiveRefresh } from "@/components/live-refresh";
import { SquareUpList } from "@/components/square-up";
import { getDb } from "@/db";
import { type ActivityItem, recentActivity } from "@/domain/activity";
import { pendingSubmissions, type SubmissionView } from "@/domain/approvals";
import { listChores } from "@/domain/chores";
import { houseBalances } from "@/domain/ledger";
import { debtsForUser, houseSquareUp } from "@/domain/settleup";
import { openSwaps, type SwapView } from "@/domain/swaps";
import { listNudges, teamOnDuty } from "@/domain/teams";
import { DONE_OPENS_MS } from "@/domain/turns";
import { houseTurns, type TurnView } from "@/domain/views";
import { openProposals } from "@/domain/worth";
import { baseUrl, requireMember } from "@/lib/current";
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
      return {
        text: item.data.firstName
          ? `${who} added ${item.data.name}, starting with ${item.data.firstName}`
          : `${who} added ${item.data.name}`,
      };
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
      return {
        text: item.data.teamName ? `${item.data.teamName} missed ${chore}` : `${who} missed ${chore}`,
        cents: -amount,
      };
    case "team_added":
      return { text: `${who} added ${item.data.name}` };
    case "team_removed":
      return { text: `${who} removed ${item.data.name}` };
    case "teams_saved":
      return { text: `${who} changed the teams` };
    case "nudged":
      return { text: `${who} told ${item.data.teamName}: ${item.data.label}` };
    case "turn_assigned":
      return { text: `${who} gave ${chore} to ${item.data.toName}` };
    case "dispute_raised":
      return { text: `${who} disputed ${chore}` };
    case "worth_proposed":
      return {
        text:
          item.data.proposal === "new"
            ? `${who} proposed ${item.data.name}, worth ${formatCents(Number(item.data.worthCents))}`
            : `${who} proposed ${item.data.name} be worth ${formatCents(Number(item.data.worthCents))}`,
      };
    case "worth_agreed":
      return {
        text: `The house agreed: ${item.data.name} is worth ${formatCents(Number(item.data.worthCents))}`,
      };
    case "worth_not_agreed":
      return {
        text: `${item.data.name} at ${formatCents(Number(item.data.worthCents))} ${item.data.outcome === "lapsed" ? "lapsed without enough votes" : "was turned down"}`,
      };
    case "swap_requested":
      return { text: `${who} asked ${item.data.toName} to take ${chore}` };
    case "swap_accepted":
      return {
        text: item.data.backChoreName
          ? `${who} swapped with ${item.data.fromName}: ${chore} for ${item.data.backChoreName}`
          : `${who} took ${chore} for ${item.data.fromName}`,
      };
    case "proof_sent":
      return { text: `${who} sent photos for ${chore}` };
    case "proof_rejected":
      return { text: `The house said ${who === "You" ? "your" : `${who}'s`} ${chore} was not done` };
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
    case "bill_edited": {
      const before = Number(item.data.previousTotalCents ?? 0);
      const after = Number(item.data.totalCents ?? 0);
      return {
        text:
          before && before !== after
            ? `${who} changed ${item.data.description}: ${formatCents(before)} → ${formatCents(after)}`
            : `${who} changed ${item.data.description}`,
      };
    }
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
  if (turn.teamName) return `${turn.teamName} missed it.`;
  const mine = turn.assigneeMemberId === meId;
  if (turn.openedReason === "skip") return mine ? "You skipped this." : `${turn.assigneeName} skipped it.`;
  if (turn.openedReason === "dispute") return "The house said it was not done.";
  return mine ? "You missed this." : `${turn.assigneeName} missed it.`;
}

/** "Ask someone to take it" on one of your own turns, or the request you have already sent. */
function SwapControls({
  turn,
  asked,
  housemates,
  theirTurns,
  now,
  tz,
}: {
  turn: TurnView;
  asked: SwapView | undefined;
  housemates: { memberId: string; name: string }[];
  theirTurns: TurnView[];
  now: Date;
  tz: string;
}) {
  if (asked) {
    return (
      <div className="swap-asked">
        <p className="small muted">
          You asked {asked.toName} to take it
          {asked.giveBack ? ` for your doing their ${asked.giveBack.choreName}` : ""}. It stays yours until
          they accept.
        </p>
        <form action={swapCancelAction}>
          <input type="hidden" name="requestId" value={asked.id} />
          <SubmitButton className="btn-quiet">Cancel the request</SubmitButton>
        </form>
      </div>
    );
  }
  return (
    <details className="editor swap">
      <summary>
        <span>Ask someone to take it</span>
      </summary>
      <div className="body">
        <form action={swapRequestAction}>
          <input type="hidden" name="turnId" value={turn.id} />
          <div className="field">
            <label htmlFor={`swap-to-${turn.id}`}>Who</label>
            <select id={`swap-to-${turn.id}`} name="toMemberId" className="input" required>
              {housemates.map((m) => (
                <option key={m.memberId} value={m.memberId}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          {theirTurns.length > 0 && (
            <div className="field">
              <label htmlFor={`swap-back-${turn.id}`}>In exchange, you do</label>
              <select id={`swap-back-${turn.id}`} name="giveBackTurnId" className="input" defaultValue="">
                <option value="">Nothing: ask it as a favour</option>
                {theirTurns.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.assigneeName}'s {t.choreName}, {dueLabel(t.dueAt, now, tz)}
                  </option>
                ))}
              </select>
              <span className="hint">
                Pick one of the chosen person's turns. It swaps only if they accept.
              </span>
            </div>
          )}
          <SubmitButton className="btn btn-block" pendingLabel="Asking…">
            Ask
          </SubmitButton>
        </form>
      </div>
    </details>
  );
}

/** True when this open chore expired on the viewer (or their team), so they cannot claim it. */
function expiredOnMe(turn: TurnView, member: { id: string; teamId: string | null }): boolean {
  return turn.teamId ? turn.teamId === member.teamId : turn.assigneeMemberId === member.id;
}

function ProofPhotos({ proof }: { proof: SubmissionView }) {
  return (
    <div className="proof-photos">
      {proof.photoIds.map((id, i) => (
        <a key={id} href={`/api/photos/${id}`} target="_blank" rel="noreferrer">
          {/* biome-ignore lint/performance/noImgElement: proof photos are private and served by our own route */}
          <img
            className="thumb"
            src={`/api/photos/${id}`}
            alt={`Proof ${i + 1} of ${proof.photoIds.length} for ${proof.choreName}`}
          />
        </a>
      ))}
    </div>
  );
}

/** Shown on a chore whose proof is with the house: who sent it and how the vote stands. */
function ProofStatus({
  proof,
  meId,
  now,
  tz,
}: {
  proof: SubmissionView;
  meId: string;
  now: Date;
  tz: string;
}) {
  const mine = proof.memberId === meId;
  return (
    <div className="proof-status">
      <p className="small">
        <strong>{mine ? "You sent photos." : `${proof.memberName} sent photos.`}</strong> {proof.yes} of{" "}
        {proof.needed} {proof.needed === 1 ? "says" : "say"} it looks done
        {proof.no > 0 ? `, ${proof.no} not done` : ""}. It counts by{" "}
        {midSentence(dueLabel(proof.closesAt, now, tz))} unless most say it is not.
      </p>
      <ProofPhotos proof={proof} />
    </div>
  );
}

export default async function HousePage({ searchParams }: Props) {
  const { user, member, house } = await requireMember();
  const db = getDb();
  const now = new Date();
  const etransfer = house.moneyMode === "etransfer";
  const [balances, turns, pending, activity, chores, myDebts, squareUp] = await Promise.all([
    houseBalances(db, house.id),
    houseTurns(db, house.id),
    pendingSubmissions(db, house.id),
    recentActivity(db, house.id, 30),
    listChores(db, house.id),
    etransfer ? debtsForUser(db, user.id) : Promise.resolve([]),
    etransfer ? houseSquareUp(db, house.id) : Promise.resolve({ lines: [], unclaimedCents: 0 }),
  ]);
  const [duty, nudges, proposals, swaps] = await Promise.all([
    teamOnDuty(db, house.id, now),
    listNudges(db, house.id),
    openProposals(db, house.id),
    openSwaps(db, house.id),
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
  // Chores my team has that a teammate is down for: I can still do them, or take them over.
  const myTeams = turns.filter(
    (t) =>
      t.status === "assigned" && t.teamId && t.teamId === member.teamId && t.assigneeMemberId !== member.id,
  );
  const others = turns.filter(
    (t) => t.status === "assigned" && t.assigneeMemberId !== member.id && !myTeams.includes(t),
  );
  const potTotal = balances.reduce((sum, b) => sum + b.balanceCents, 0);
  // Proof waiting on the house, by turn: a turn with proof in is not waiting on anyone to do it.
  const proofFor = new Map(pending.map((p) => [p.turnId, p]));
  const toVoteOn = pending.filter((p) => p.memberId !== member.id);
  const swapAsked = new Map(swaps.filter((s) => s.fromMemberId === member.id).map((s) => [s.turnId, s]));
  const swapsForMe = swaps.filter((s) => s.toMemberId === member.id);
  const housemates = balances.filter((b) => b.memberId !== member.id && b.status === "active");
  // One-person turns others have waiting, which can be offered in exchange for a swap.
  const theirTurns = turns.filter(
    (t) => t.status === "assigned" && !t.teamId && t.assigneeMemberId !== member.id && !proofFor.has(t.id),
  );
  const inviteUrl = `${await baseUrl()}/join/${house.inviteCode}`;

  return (
    <main className="shell">
      <Masthead current="house" settle={etransfer} />
      <LiveRefresh />
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

      {duty && (
        <section className="section">
          <h2 className="label">On duty</h2>
          <div className="row">
            <span>
              {duty.team.name}
              {duty.team.id === member.teamId && <span className="muted"> (your team)</span>}
            </span>
            <span className="leader" />
            <span className="small muted">until {dateLabel(duty.until)}</span>
          </div>
          <p className="small muted">
            {duty.team.memberNames.length > 0
              ? duty.team.memberNames.join(", ")
              : "Nobody is on this team yet."}
          </p>
          {isActive && nudges.length > 0 && (
            <div className="nudges">
              {nudges.map((nudge) => (
                <form key={nudge.id} action={nudgeAction}>
                  <input type="hidden" name="nudgeId" value={nudge.id} />
                  <SubmitButton className="btn" pendingLabel="Telling them…">
                    {nudge.label}
                  </SubmitButton>
                </form>
              ))}
            </div>
          )}
          {isActive && nudges.length > 0 && (
            <p className="small muted" style={{ marginTop: "var(--space-2)" }}>
              Tap one to email everyone on {duty.team.name}.
            </p>
          )}
        </section>
      )}

      {balances.length < 2 && (
        <section className="callout">
          <h2>Invite your housemates</h2>
          <p>Drop this link in the house chat. They open it, sign in, and they are in.</p>
          <div className="invite">
            <input className="input" readOnly value={inviteUrl} aria-label="Invite link" />
            <ShareLink url={inviteUrl} houseName={house.name} />
          </div>
        </section>
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
                  {turn.teamName && ` · ${turn.teamName}'s chore, and you have it`}
                  {turn.bountyCents > 0 && " · a bounty is waiting if you do it on time"}
                </p>
                {proofFor.has(turn.id) ? (
                  <ProofStatus proof={proofFor.get(turn.id)!} meId={member.id} now={now} tz={house.tz} />
                ) : (
                  <div className="actions">
                    {turn.dueAt.getTime() - now.getTime() > DONE_OPENS_MS ? (
                      <p className="small muted">
                        You can mark it done from{" "}
                        {midSentence(dueLabel(new Date(turn.dueAt.getTime() - DONE_OPENS_MS), now, house.tz))}
                        .
                      </p>
                    ) : (
                      <form action={doneAction}>
                        <input type="hidden" name="turnId" value={turn.id} />
                        <PhotoSubmit label="Done: add photos" />
                      </form>
                    )}
                    <p className="small muted">
                      {turn.teamId
                        ? `Worth ${formatCents(turn.skipPriceCents)}. If nobody on ${turn.teamName} does it in time, the team shares that and it goes to whoever does it.`
                        : `Worth ${formatCents(turn.skipPriceCents)}. Let it expire and that comes off your balance and goes to whoever does it.`}
                    </p>
                  </div>
                )}
                {!turn.teamId && !proofFor.has(turn.id) && housemates.length > 0 && (
                  <SwapControls
                    turn={turn}
                    asked={swapAsked.get(turn.id)}
                    housemates={housemates}
                    theirTurns={theirTurns}
                    now={now}
                    tz={house.tz}
                  />
                )}
              </article>
            ))
          )}
        </section>
      )}

      {isActive && myTeams.length > 0 && (
        <section className="section">
          <h2 className="label">Your team's chores</h2>
          {myTeams.map((turn) => (
            <article key={turn.id} className="turn">
              <div className="turn-head">
                <h3>{turn.choreName}</h3>
                {turn.bountyCents > 0 && <span className="bounty">+{formatCents(turn.bountyCents)}</span>}
              </div>
              <p className="meta">
                {turn.assigneeName} has it · due {midSentence(dueLabel(turn.dueAt, now, house.tz))}
              </p>
              {proofFor.has(turn.id) ? (
                <ProofStatus proof={proofFor.get(turn.id)!} meId={member.id} now={now} tz={house.tz} />
              ) : (
                <div className="actions">
                  {turn.dueAt.getTime() - now.getTime() <= DONE_OPENS_MS && (
                    <form action={doneAction}>
                      <input type="hidden" name="turnId" value={turn.id} />
                      <PhotoSubmit label="I did it: add photos" />
                    </form>
                  )}
                  <form action={assignTurnAction}>
                    <input type="hidden" name="turnId" value={turn.id} />
                    <SubmitButton pendingLabel="Saving…">I'll take it</SubmitButton>
                  </form>
                </div>
              )}
            </article>
          ))}
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
                {openReason(turn, member.id)} The first person to do it and send photos takes the money, once
                the house agrees it is done.
              </p>
              {proofFor.has(turn.id) ? (
                <ProofStatus proof={proofFor.get(turn.id)!} meId={member.id} now={now} tz={house.tz} />
              ) : expiredOnMe(turn, member) ? (
                <p className="small muted">
                  It expired on {turn.teamId ? "your team" : "you"}, so the money goes to whoever else does
                  it.
                </p>
              ) : (
                isActive && (
                  <div className="actions actions-one">
                    <form action={claimAction}>
                      <input type="hidden" name="turnId" value={turn.id} />
                      <PhotoSubmit
                        label={`I did it: add photos for ${formatCents(turn.bountyCents)}`}
                        className="btn btn-accent"
                      />
                    </form>
                  </div>
                )
              )}
            </article>
          ))}
        </section>
      )}

      {isActive && swapsForMe.length > 0 && (
        <section className="section">
          <h2 className="label">Asked to swap</h2>
          {swapsForMe.map((s) => (
            <article key={s.id} className="turn">
              <div className="turn-head">
                <h3>{s.choreName}</h3>
              </div>
              <p className="meta">
                {s.fromName} asks you to take {s.choreName}, due{" "}
                {midSentence(dueLabel(s.dueAt, now, house.tz))}.
                {s.giveBack
                  ? ` In exchange, ${s.fromName} does your ${s.giveBack.choreName}, due ${midSentence(dueLabel(s.giveBack.dueAt, now, house.tz))}.`
                  : " Nothing in exchange: it is a favour."}{" "}
                If you accept, it is yours, and if it expires it costs you.
              </p>
              <div className="actions">
                <form action={swapAnswerAction}>
                  <input type="hidden" name="requestId" value={s.id} />
                  <input type="hidden" name="accept" value="yes" />
                  <SubmitButton className="btn btn-primary">Accept</SubmitButton>
                </form>
                <form action={swapAnswerAction}>
                  <input type="hidden" name="requestId" value={s.id} />
                  <input type="hidden" name="accept" value="no" />
                  <SubmitButton>Decline</SubmitButton>
                </form>
              </div>
            </article>
          ))}
        </section>
      )}

      {proposals.length > 0 && (
        <section className="section">
          <h2 className="label">What chores are worth</h2>
          {proposals.map((p) => {
            const myVote = p.votes[member.id];
            const mineToAsk = p.proposedById === member.id;
            return (
              <article key={p.id} className="turn">
                <div className="turn-head">
                  <h3>{p.choreName}</h3>
                  <span className="bounty">{formatCents(p.worthCents)}</span>
                </div>
                <p className="meta">
                  {mineToAsk ? "You" : p.proposedByName}{" "}
                  {p.kind === "new"
                    ? `${mineToAsk ? "want" : "wants"} to add this chore, worth ${formatCents(p.worthCents)}.`
                    : `${mineToAsk ? "want" : "wants"} it to be worth ${formatCents(p.worthCents)} instead of ${formatCents(p.currentCents)}.`}{" "}
                  That is what it costs if it expires, and what whoever does it instead takes. {p.yes} of{" "}
                  {p.needed} agree so far; it lapses {midSentence(dueLabel(p.closesAt, now, house.tz))}.
                </p>
                {isActive && !mineToAsk && (
                  <div className="actions">
                    <form action={worthVoteAction}>
                      <input type="hidden" name="proposalId" value={p.id} />
                      <input type="hidden" name="agree" value="yes" />
                      <SubmitButton className={myVote === true ? "btn btn-primary" : "btn"}>
                        Agree
                      </SubmitButton>
                    </form>
                    <form action={worthVoteAction}>
                      <input type="hidden" name="proposalId" value={p.id} />
                      <input type="hidden" name="agree" value="no" />
                      <SubmitButton className={myVote === false ? "btn btn-primary" : "btn"}>No</SubmitButton>
                    </form>
                  </div>
                )}
              </article>
            );
          })}
        </section>
      )}

      {isActive && toVoteOn.length > 0 && (
        <section className="section">
          <h2 className="label">Did they do it?</h2>
          {toVoteOn.map((p) => {
            const myVote = p.votes[member.id];
            return (
              <article key={p.id} className="turn">
                <div className="turn-head">
                  <h3>{p.choreName}</h3>
                  <span className="num small muted">
                    {p.yes} of {p.needed}
                  </span>
                </div>
                <p className="meta">
                  {p.memberName} {p.kind === "claim" ? "did this expired chore" : "says it is done"}
                  {p.payoutCents > 0 ? ` and gets ${formatCents(p.payoutCents)} if it counts` : ""}. It counts
                  once {p.needed} {p.needed === 1 ? "person says" : "people say"} it looks done, or{" "}
                  {midSentence(dueLabel(p.closesAt, now, house.tz))} if not enough say it is not.
                </p>
                <ProofPhotos proof={p} />
                <div className="actions">
                  <form action={approvalVoteAction}>
                    <input type="hidden" name="submissionId" value={p.id} />
                    <input type="hidden" name="approve" value="yes" />
                    <SubmitButton className={myVote === true ? "btn btn-primary" : "btn"}>
                      Looks done
                    </SubmitButton>
                  </form>
                  <form action={approvalVoteAction}>
                    <input type="hidden" name="submissionId" value={p.id} />
                    <input type="hidden" name="approve" value="no" />
                    <SubmitButton className={myVote === false ? "btn btn-primary" : "btn"}>
                      Not done
                    </SubmitButton>
                  </form>
                </div>
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
                {turn.choreName}{" "}
                <span className="muted">
                  · {turn.teamName ? `${turn.teamName}, ${turn.assigneeName}` : turn.assigneeName}
                </span>
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
            <p className="empty">
              {iOwe.length + owedToMe.length > 0
                ? "Nothing new since the last settle-up. Open payments are on the Settle up page."
                : "Everyone is square."}
            </p>
          ) : (
            <SquareUpList lines={squareLines} meId={member.id} canAct={isActive} />
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
                  Request all payments
                </SubmitButton>
              </form>
              <p className="small muted" style={{ marginTop: "var(--space-3)" }}>
                Pay or Request on a line is just between you and that person. "Request all payments" asks
                everyone on the list to pay now and locks the bills behind it. Nothing is requested until
                someone presses one of these.
              </p>
            </>
          )}
        </section>
      )}

      {etransfer ? (
        <section className="section">
          <h2 className="label">Balances</h2>
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
            Nobody pays in. These are running balances from bills and chores. They stay here until you pay or
            request each other above.
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
