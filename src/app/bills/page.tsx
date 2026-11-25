import Link from "next/link";
import { notFound } from "next/navigation";
import { Flash, Masthead } from "@/components/frame";
import { getDb } from "@/db";
import { type BillView, houseBills } from "@/domain/bills";
import { requireMember } from "@/lib/current";
import { ago } from "@/lib/format";
import { formatCents } from "@/money";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** What this bill means for the person looking at it. */
function myPart(bill: BillView, meId: string): string {
  const mine = bill.shares.find((s) => s.memberId === meId);
  if (bill.paidByMemberId === meId) {
    const back = bill.totalCents - (mine?.shareCents ?? 0);
    return back > 0 ? `you get back ${formatCents(back)}` : "all yours";
  }
  return mine && mine.shareCents > 0 ? `your share ${formatCents(mine.shareCents)}` : "not yours";
}

/** The house's shared bills, newest first. */
export default async function BillsPage({ searchParams }: Props) {
  const { member, house } = await requireMember("/bills");
  if (house.moneyMode !== "etransfer") notFound();
  const bills = await houseBills(getDb(), house.id);
  const now = new Date();

  return (
    <main className="shell">
      <Masthead current="bills" settle />
      <Flash params={await searchParams} />
      <h1 className="house-name">Bills</h1>
      {member.status === "active" && (
        <p style={{ marginTop: "var(--space-4)" }}>
          <Link href="/bills/new" className="btn btn-primary btn-block">
            Add a bill
          </Link>
        </p>
      )}
      <section className="section">
        {bills.length === 0 ? (
          <p className="empty">No bills yet.</p>
        ) : (
          bills.map((bill) => (
            <article key={bill.id} className="turn">
              <div className="turn-head">
                <h3>
                  <Link href={`/bills/${bill.id}`}>{bill.description}</Link>
                </h3>
                <span className="bounty">{formatCents(bill.totalCents)}</span>
              </div>
              <p className="meta">
                {bill.paidByMemberId === member.id ? "You" : bill.paidByName} paid · {myPart(bill, member.id)}
              </p>
              <p className="meta">
                {ago(bill.createdAt, now)}
                {bill.edited ? " · edited" : ""}
                {bill.locked ? " · settled up" : ""}
              </p>
            </article>
          ))
        )}
      </section>
    </main>
  );
}
