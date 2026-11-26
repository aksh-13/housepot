import Link from "next/link";
import { redirect } from "next/navigation";
import { signOutAction } from "@/app/actions";
import { Flash, PlainMasthead } from "@/components/frame";
import { getDb } from "@/db";
import { memberForUser } from "@/domain/houses";
import { currentUser } from "@/lib/current";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function FrontPage({ searchParams }: Props) {
  const user = await currentUser();
  if (user && (await memberForUser(getDb(), user.id))) redirect("/house");

  return (
    <main className="shell">
      <PlainMasthead>
        {user ? (
          <form action={signOutAction}>
            <button type="submit" className="btn-quiet">
              Sign out
            </button>
          </form>
        ) : (
          <Link href="/login">Sign in</Link>
        )}
      </PlainMasthead>
      <Flash params={await searchParams} />

      <section className="hero section">
        <h1>Chores and bills for your house, on one tab.</h1>
        <p className="lede">
          Split the groceries, rotate the chores, and see exactly who owes whom. Skip your turn and $5 goes to
          whoever does the job.
        </p>
        <div className="actions actions-one">
          <Link href="/new" className="btn btn-primary">
            Start a house
          </Link>
        </div>
        <p className="small muted" style={{ marginTop: "var(--space-3)" }}>
          Got an invite link from a housemate? Open it to join their house.
        </p>

        <figure className="receipt">
          <figcaption className="visually-hidden">An example house</figcaption>
          <div className="title">
            <span>This month</span>
            <span>12 Elm St</span>
          </div>
          <div className="row">
            <span>Akshaj</span>
            <span className="leader" />
            <span className="amt gain">+$47.60</span>
          </div>
          <div className="row">
            <span>Priya</span>
            <span className="leader" />
            <span className="amt loss">−$19.80</span>
          </div>
          <div className="row">
            <span>Sam</span>
            <span className="leader" />
            <span className="amt loss">−$27.80</span>
          </div>
          <p className="note">
            Akshaj paid $67.80 for groceries, split by receipt
            <br />
            Sam missed Garbage · Akshaj did it, with a photo
            <br />
            To square up: Sam pays Akshaj $27.80 · Priya pays Akshaj $19.80
          </p>
        </figure>
      </section>

      <section className="section">
        <h2 className="label">How it works</h2>
        <ol className="steps">
          <li>
            <div>
              <strong>One link in the house chat.</strong>
              <span>
                Everyone signs in with an emailed code. No app to install, no password, nothing to pay.
              </span>
            </div>
          </li>
          <li>
            <div>
              <strong>Add bills as they happen.</strong>
              <span>
                Split equally, or by receipt: say what each person had and the tax and tip are shared out
                fairly.
              </span>
            </div>
          </li>
          <li>
            <div>
              <strong>Chores take turns.</strong>
              <span>
                Do yours and send a photo, or skip it for a price. A skipped or missed chore is open to the
                house, and the first one to do it takes the money.
              </span>
            </div>
          </li>
          <li>
            <div>
              <strong>Square up by e-Transfer.</strong>
              <span>
                One running balance each, turned into the fewest payments. Pay a housemate whenever you are
                ready.
              </span>
            </div>
          </li>
        </ol>
      </section>

      <p className="foot">
        Housepot is a student project in pilot. It keeps score and never holds your money: you pay each other
        directly.
      </p>
    </main>
  );
}
