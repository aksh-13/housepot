import { redirect } from "next/navigation";
import { createHouseAction } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { Flash, PlainMasthead } from "@/components/frame";
import { getDb } from "@/db";
import { memberForUser } from "@/domain/houses";
import { requireUser } from "@/lib/current";
import { cardHousesOn } from "@/settings";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function NewHousePage({ searchParams }: Props) {
  const user = await requireUser("/new");
  if (await memberForUser(getDb(), user.id)) redirect("/house");

  return (
    <main className="shell">
      <PlainMasthead />
      <Flash params={await searchParams} />
      <section className="section">
        <h1 className="house-name">Start a house</h1>
        <p className="muted small" style={{ margin: "var(--space-2) 0 var(--space-5)" }}>
          A few questions, then a short walkthrough: your chores and what each is worth, then a link to drop
          in your house chat.
        </p>
        <form action={createHouseAction}>
          {!user.name && (
            <div className="field">
              <label htmlFor="name">Your first name</label>
              <input
                id="name"
                name="name"
                className="input"
                autoComplete="given-name"
                maxLength={40}
                required
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="houseName">House name</label>
            <input
              id="houseName"
              name="houseName"
              className="input"
              placeholder="12 Elm St"
              maxLength={60}
              required
            />
          </div>
          {cardHousesOn() ? (
            <>
              <fieldset className="field">
                <legend>How money works</legend>
                <label className="check">
                  <input type="radio" name="moneyMode" value="etransfer" defaultChecked />
                  <span>
                    <strong>Settle up by e-Transfer.</strong> Free. Nobody pays in: when you are ready,
                    whoever is down sends whoever is up an e-Transfer.
                  </span>
                </label>
                <label className="check">
                  <input type="radio" name="moneyMode" value="card" />
                  <span>
                    <strong>Card deposits.</strong> Everyone pays a deposit by card into a pot the app holds.
                    Card fees apply.
                  </span>
                </label>
              </fieldset>
              <div className="field">
                <label htmlFor="deposit">Deposit each person pays in (card deposits only)</label>
                <select id="deposit" name="deposit" className="input" defaultValue="20">
                  <option value="10">$10</option>
                  <option value="20">$20</option>
                  <option value="40">$40</option>
                  <option value="60">$60</option>
                </select>
                <span className="hint">
                  You get back whatever is left at the end of term. An expired chore costs its worth, $5 by
                  default.
                </span>
              </div>
            </>
          ) : (
            <input type="hidden" name="moneyMode" value="etransfer" />
          )}
          <fieldset className="field">
            <legend>How does your house share chores?</legend>
            <label className="check">
              <input type="radio" name="sharing" value="turns" defaultChecked />
              <span>
                <strong>Everyone takes turns.</strong> Each chore goes round the whole house, one person at a
                time.
              </span>
            </label>
            <label className="check">
              <input type="radio" name="sharing" value="teams" />
              <span>
                <strong>Teams take turns on duty.</strong> For bigger houses: one team is on duty for a week
                or more, then the next. You can still have one-person chores too.
              </span>
            </label>
          </fieldset>
          <div className="pair">
            <div className="field">
              <label htmlFor="teamCount">Teams (if you use them)</label>
              <select id="teamCount" name="teamCount" className="input" defaultValue="2">
                <option value="2">2 teams</option>
                <option value="3">3 teams</option>
                <option value="4">4 teams</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="teamWeeks">Each on duty for</label>
              <select id="teamWeeks" name="teamWeeks" className="input" defaultValue="1">
                <option value="1">1 week</option>
                <option value="2">2 weeks</option>
                <option value="3">3 weeks</option>
                <option value="4">4 weeks</option>
              </select>
            </div>
          </div>
          <p className="hint" style={{ marginBottom: "var(--space-4)" }}>
            Housemates pick their team when they join. Names, lengths and who is on which can all change later
            on the Teams tab.
          </p>
          <SubmitButton className="btn btn-primary btn-block" pendingLabel="Creating…">
            Create the house
          </SubmitButton>
        </form>
      </section>
    </main>
  );
}
