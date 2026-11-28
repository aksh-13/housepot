import Link from "next/link";
import { addChoreAction, finishWelcomeAction, joinTeamAction, savePayoutAction } from "@/app/actions";
import { ShareLink, SubmitButton } from "@/components/buttons";
import { ChoreFields } from "@/components/chore-fields";
import { Flash, PlainMasthead } from "@/components/frame";
import { getDb } from "@/db";
import { listChores } from "@/domain/chores";
import { BANKS, startedHouse } from "@/domain/houses";
import { listTeams } from "@/domain/teams";
import { openProposals } from "@/domain/worth";
import { baseUrl, requireMember } from "@/lib/current";
import { scheduleLabel, timeLabel } from "@/lib/format";
import { formatCents } from "@/money";
import { localDate } from "@/time";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

type Step = "how" | "chores" | "pay" | "team" | "invite";

const TITLES: Record<Step, string> = {
  how: "How Housepot works",
  chores: "Your chores",
  pay: "Getting paid",
  team: "Your team",
  invite: "Invite your housemates",
};

/** The first-run walkthrough: one thing per screen, in order, with a way to come back to it. */
export default async function WelcomePage({ searchParams }: Props) {
  const { user, member, house } = await requireMember("/welcome");
  const params = await searchParams;
  const db = getDb();
  const [founder, chores, teams, proposals, origin] = await Promise.all([
    startedHouse(db, house.id, member.id),
    listChores(db, house.id),
    listTeams(db, house.id),
    openProposals(db, house.id),
    baseUrl(),
  ]);
  const etransfer = house.moneyMode === "etransfer";

  // Starting a house: learn the rules, add the chores and their worth, say where to get paid, invite.
  // Joining one: learn the rules, see what you are agreeing to, say where to get paid, pick a team.
  const steps: Step[] = founder
    ? ["how", "chores", ...(etransfer ? (["pay"] as const) : []), "invite"]
    : [
        "how",
        "chores",
        ...(etransfer ? (["pay"] as const) : []),
        ...(teams.length > 0 ? (["team"] as const) : []),
      ];
  const asked = String(params.step ?? "");
  const step: Step = (steps as string[]).includes(asked) ? (asked as Step) : steps[0];
  const index = steps.indexOf(step);
  const next = steps[index + 1];
  const last = next === undefined;
  const again = member.onboardedAt !== null;

  const agreedChores = chores.filter((c) => c.agreed);
  const waitingChores = chores.filter((c) => !c.agreed);

  return (
    <main className="shell">
      <PlainMasthead />
      <Flash params={params} />
      <ol className="welcome-dots" aria-label={`Step ${index + 1} of ${steps.length}`}>
        {steps.map((s, i) => (
          <li key={s} className={i === index ? "here" : i < index ? "done" : ""}>
            <Link href={`/welcome?step=${s}`} aria-label={TITLES[s]} />
          </li>
        ))}
      </ol>
      <p className="label">
        Step {index + 1} of {steps.length}
      </p>
      <h1 className="house-name">{TITLES[step]}</h1>

      {step === "how" && (
        <section className="section">
          <p className="lede">
            {founder
              ? `You are setting up ${house.name}.`
              : `Welcome to ${house.name}, ${user.name ?? "housemate"}.`}{" "}
            Here is the deal, in five lines.
          </p>
          <ol className="steps">
            <li>
              <div>
                <strong>Chores take turns.</strong>
                <span>
                  Each one goes round the house in order
                  {teams.length > 0 ? ", or round the team on duty" : ""}.
                </span>
              </div>
            </li>
            <li>
              <div>
                <strong>Done means photos.</strong>
                <span>
                  Send one to four photos before the deadline. It counts once most of the house says it looks
                  done, or after 48 hours if not enough people say it is not.
                </span>
              </div>
            </li>
            <li>
              <div>
                <strong>Let it expire and it costs you.</strong>
                <span>
                  Its worth comes off your balance. The chore is then open to everyone else: the first to do
                  it, with photos, takes that money. You cannot claim back your own.
                </span>
              </div>
            </li>
            <li>
              <div>
                <strong>The house agrees on what chores are worth.</strong>
                <span>
                  {founder
                    ? "You set them now. Once people join, a new chore or a new worth needs most of the house to agree."
                    : "A new chore, or a new worth for one, needs most of the house to agree."}
                </span>
              </div>
            </li>
            <li>
              <div>
                <strong>Can't make it? Ask someone to swap.</strong>
                <span>It moves only if they accept, and stays yours until then.</span>
              </div>
            </li>
          </ol>
          {etransfer && (
            <p className="small muted">
              Nobody pays in. Balances are a running score, and housemates square up with each other by
              e-Transfer whenever they like.
            </p>
          )}
        </section>
      )}

      {step === "chores" && founder && (
        <section className="section stack">
          <p className="muted">
            Add every chore the house shares, with when it is due and what it is worth. The worth only matters
            if someone lets it expire: it is what they pay, and what whoever does it instead takes.
          </p>
          <ChoreList chores={agreedChores} />
          {waitingChores.length > 0 && (
            <p className="small muted">
              Waiting for the house to agree: {waitingChores.map((c) => c.name).join(", ")}.
            </p>
          )}
          <details className="editor" open={chores.length === 0}>
            <summary>
              <span>{chores.length === 0 ? "Add your first chore" : "Add another chore"}</span>
            </summary>
            <div className="body">
              <form action={addChoreAction}>
                <input type="hidden" name="welcomeHere" value="chores" />
                <ChoreFields
                  today={localDate(new Date(), house.tz)}
                  idPrefix="welcome"
                  hasTeams={teams.length > 0}
                />
                <SubmitButton className="btn btn-primary btn-block" pendingLabel="Adding…">
                  Add chore
                </SubmitButton>
              </form>
            </div>
          </details>
        </section>
      )}

      {step === "chores" && !founder && (
        <section className="section stack">
          <p className="muted">
            These are the house's chores and what each one is worth: what you pay if you let it expire, and
            what you take if you do one that expired on someone else.
          </p>
          {agreedChores.length === 0 ? (
            <p className="empty">No chores yet. Anyone can propose one from the Chores tab.</p>
          ) : (
            <ChoreList chores={agreedChores} />
          )}
          {proposals.length > 0 && (
            <p className="small muted">
              Being voted on:{" "}
              {proposals.map((p) => `${p.choreName} at ${formatCents(p.worthCents)}`).join(", ")}. Vote on the
              House page.
            </p>
          )}
        </section>
      )}

      {step === "pay" && (
        <section className="section stack">
          <p className="muted">
            The email your bank receives Interac e-Transfers at, so housemates who owe you can pay you. They
            see it only when they owe you.
          </p>
          <form action={savePayoutAction}>
            <input type="hidden" name="welcomeHere" value="pay" />
            <input type="hidden" name="welcomeNext" value={next ?? "pay"} />
            <div className="field">
              <label htmlFor="etransferEmail">Your e-Transfer email</label>
              <input
                id="etransferEmail"
                name="etransferEmail"
                type="email"
                className="input"
                autoComplete="email"
                defaultValue={member.etransferEmail ?? user.email ?? ""}
                placeholder="you@example.com"
              />
            </div>
            <div className="field">
              <label htmlFor="bank">Your bank (optional)</label>
              <select id="bank" name="bank" className="input" defaultValue={member.bank ?? ""}>
                <option value="">Not set</option>
                {Object.entries(BANKS).map(([key, b]) => (
                  <option key={key} value={key}>
                    {b.name}
                  </option>
                ))}
              </select>
              <span className="hint">For a shortcut to your bank when you pay someone.</span>
            </div>
            <SubmitButton className="btn btn-primary btn-block" pendingLabel="Saving…">
              {last ? "Save" : "Save and continue"}
            </SubmitButton>
          </form>
        </section>
      )}

      {step === "team" && (
        <section className="section stack">
          <p className="muted">
            {house.name} splits into teams that take turns being on duty. Which one are you on?
          </p>
          {teams.map((team) => (
            <form key={team.id} action={joinTeamAction} className="setting">
              <div>
                <h3>
                  {team.name}
                  {member.teamId === team.id && <span className="muted"> (you)</span>}
                </h3>
                <p>{team.memberNames.length > 0 ? team.memberNames.join(", ") : "Nobody yet"}</p>
              </div>
              <input type="hidden" name="teamId" value={team.id} />
              <input type="hidden" name="welcomeHere" value="team" />
              <input type="hidden" name="welcomeNext" value="team" />
              <SubmitButton>{member.teamId === team.id ? "Joined" : "Join"}</SubmitButton>
            </form>
          ))}
          <p className="small muted">Not sure? Skip it, and change it any time on the Teams tab.</p>
        </section>
      )}

      {step === "invite" && (
        <section className="section stack">
          <p className="muted">Drop this link in the house chat. They open it, sign in, and they are in.</p>
          <div className="invite">
            <input
              className="input"
              readOnly
              value={`${origin}/join/${house.inviteCode}`}
              aria-label="Invite link"
            />
            <ShareLink url={`${origin}/join/${house.inviteCode}`} houseName={house.name} />
          </div>
          {teams.length > 0 && (
            <p className="small muted">
              Your house has {teams.length} teams. Everyone who joins picks theirs, and you can move people on
              the Teams tab.
            </p>
          )}
        </section>
      )}

      <div className="actions" style={{ marginTop: "var(--space-5)" }}>
        {index > 0 && (
          <Link className="btn" href={`/welcome?step=${steps[index - 1]}`}>
            Back
          </Link>
        )}
        {last ? (
          <form action={finishWelcomeAction}>
            <SubmitButton className="btn btn-primary" pendingLabel="Opening…">
              {again ? "Back to the house" : "Start"}
            </SubmitButton>
          </form>
        ) : step === "chores" && founder && chores.length === 0 ? (
          <span className="small muted">Add at least one chore to go on.</span>
        ) : (
          <Link className="btn btn-primary" href={`/welcome?step=${next}`}>
            {step === "pay" || step === "team" ? "Skip for now" : "Next"}
          </Link>
        )}
      </div>
    </main>
  );
}

function ChoreList({ chores }: { chores: Awaited<ReturnType<typeof listChores>> }) {
  if (chores.length === 0) return null;
  return (
    <div>
      {chores.map((c) => (
        <div key={c.id} className="row">
          <span>
            {c.name}{" "}
            <span className="muted small">
              · {scheduleLabel(c.schedule)}, {timeLabel(c.deadlineTime)}
              {c.teamDuty ? " · team on duty" : ""}
            </span>
          </span>
          <span className="leader" />
          <span className="amt">{formatCents(c.skipPriceCents)}</span>
        </div>
      ))}
    </div>
  );
}
