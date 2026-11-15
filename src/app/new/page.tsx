import { redirect } from "next/navigation";
import { createHouseAction } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { Flash, PlainMasthead } from "@/components/frame";
import { getDb } from "@/db";
import { memberForUser } from "@/domain/houses";
import { requireUser } from "@/lib/current";

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
          You will get a link to drop in your house chat.
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
          <fieldset className="field">
            <legend>How money works</legend>
            <label className="check">
              <input type="radio" name="moneyMode" value="etransfer" defaultChecked />
              <span>
                <strong>Settle up by e-Transfer.</strong> Free. Nobody pays in: once a month, whoever is down
                sends whoever is up an e-Transfer.
              </span>
            </label>
            <label className="check">
              <input type="radio" name="moneyMode" value="card" />
              <span>
                <strong>Card deposits.</strong> Everyone pays a deposit by card into a pot the app holds. Card
                fees apply.
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
              You get back whatever is left at the end of term. A skipped chore costs $5 by default.
            </span>
          </div>
          <SubmitButton className="btn btn-primary btn-block" pendingLabel="Creating…">
            Create the house
          </SubmitButton>
        </form>
      </section>
    </main>
  );
}
