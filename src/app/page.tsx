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
        <h1>Chores, with money on the line.</h1>
        <p className="lede">
          Everyone in the house puts in $20. Skip your turn and $5 of it goes to whoever does the job.
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
          <figcaption className="visually-hidden">An example house pot</figcaption>
          <div className="title">
            <span>The pot</span>
            <span>12 Elm St</span>
          </div>
          <div className="row">
            <span>Akshaj</span>
            <span className="leader" />
            <span className="amt">$25</span>
            <span className="delta gain">+$5</span>
          </div>
          <div className="row">
            <span>Priya</span>
            <span className="leader" />
            <span className="amt">$20</span>
            <span className="delta" />
          </div>
          <div className="row">
            <span>Sam</span>
            <span className="leader" />
            <span className="amt">$15</span>
            <span className="delta loss">−$5</span>
          </div>
          <p className="note">
            Thu 9:00 PM · Sam missed Garbage
            <br />
            Thu 9:40 PM · Akshaj did it, with a photo
          </p>
        </figure>
      </section>

      <section className="section">
        <h2 className="label">How it works</h2>
        <ol className="steps">
          <li>
            <div>
              <strong>Everyone pays in.</strong>
              <span>One link in the house chat. Each housemate pays a deposit by card.</span>
            </div>
          </li>
          <li>
            <div>
              <strong>Chores take turns.</strong>
              <span>
                Do yours and send a photo, or pay to skip it. Miss the deadline and you are charged.
              </span>
            </div>
          </li>
          <li>
            <div>
              <strong>Whoever does it gets paid.</strong>
              <span>
                A skipped chore is open to the house. First one to do it, with a photo, takes the money.
              </span>
            </div>
          </li>
          <li>
            <div>
              <strong>Cash out at the end of term.</strong>
              <span>
                Do your chores and you get your whole deposit back. Cover for others and you get more.
              </span>
            </div>
          </li>
        </ol>
      </section>

      <p className="foot">
        Housepot is a student project in pilot. Balances are held on your behalf and refunded to your card.
      </p>
    </main>
  );
}
