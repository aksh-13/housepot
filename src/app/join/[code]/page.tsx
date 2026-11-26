import Link from "next/link";
import { redirect } from "next/navigation";
import { joinHouseAction } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { Flash, PlainMasthead } from "@/components/frame";
import { getDb } from "@/db";
import { houseByInvite, memberForUser } from "@/domain/houses";
import { houseBalances } from "@/domain/ledger";
import { currentUser } from "@/lib/current";
import { feeCents, formatCents } from "@/money";

type Props = {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function JoinPage({ params, searchParams }: Props) {
  const { code } = await params;
  const db = getDb();
  const house = await houseByInvite(db, code);
  const user = await currentUser();
  const path = `/join/${encodeURIComponent(code)}`;

  if (!house) {
    return (
      <main className="shell">
        <PlainMasthead />
        <section className="section">
          <h1 className="house-name">That link does not work</h1>
          <p className="muted" style={{ marginTop: "var(--space-2)" }}>
            Ask your housemate to send the invite link again.
          </p>
        </section>
      </main>
    );
  }

  const existing = user ? await memberForUser(db, user.id) : null;
  if (existing?.houseId === house.id) redirect("/house");
  const mates = (await houseBalances(db, house.id)).map((m) => m.name);

  return (
    <main className="shell">
      <PlainMasthead />
      <Flash params={await searchParams} />
      <section className="section">
        <p className="label">You are invited to</p>
        <h1 className="house-name" style={{ paddingTop: 0 }}>
          {house.name}
        </h1>
        <p className="muted small" style={{ margin: "var(--space-2) 0 var(--space-5)" }}>
          With {mates.join(", ")}.{" "}
          {house.moneyMode === "etransfer" ? (
            <>
              Nobody pays in. Skip a chore and it costs you; do someone else's and you earn it. Housemates
              square up with each other by e-Transfer whenever they like.
            </>
          ) : (
            <>
              Each housemate pays in {formatCents(house.depositCents)} (plus a{" "}
              {formatCents(feeCents(house.depositCents))} card fee). You get back what is left at the end of
              term.
            </>
          )}
        </p>

        {!user ? (
          <Link href={`/login?next=${encodeURIComponent(path)}`} className="btn btn-primary btn-block">
            Sign in to join
          </Link>
        ) : existing ? (
          <p className="flash flash-error">
            You are already in another house. Leave it first to join this one.
          </p>
        ) : (
          <form action={joinHouseAction}>
            <input type="hidden" name="code" value={code} />
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
            <SubmitButton className="btn btn-primary btn-block" pendingLabel="Joining…">
              Join {house.name}
            </SubmitButton>
          </form>
        )}
      </section>
    </main>
  );
}
