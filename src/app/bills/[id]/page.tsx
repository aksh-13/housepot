import Link from "next/link";
import { notFound } from "next/navigation";
import { deleteBillAction, editBillAction } from "@/app/actions";
import { BillForm } from "@/components/bill-form";
import { SubmitButton } from "@/components/buttons";
import { Flash, Masthead } from "@/components/frame";
import { getDb } from "@/db";
import { billById } from "@/domain/bills";
import { activeMembers } from "@/domain/houses";
import { requireMember } from "@/lib/current";
import { formatCents } from "@/money";

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** Money as the form wants it typed: "56.50". */
const typed = (cents: number) => (cents / 100).toFixed(2);

/** One bill: change it or delete it, or just read it once a settle-up has locked it. */
export default async function BillPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { member, house } = await requireMember(`/bills/${id}`);
  if (house.moneyMode !== "etransfer") notFound();
  const db = getDb();
  const bill = await billById(db, id);
  if (!bill || bill.houseId !== house.id) notFound();
  const members = (await activeMembers(db, house.id)).map((m) => ({ id: m.id, name: m.name }));
  const name = (memberId: string, fallback: string) => (memberId === member.id ? "You" : fallback);

  return (
    <main className="shell">
      <Masthead current="bills" settle />
      <Flash params={await searchParams} />
      <h1 className="house-name">{bill.description}</h1>
      {bill.locked ? (
        <section className="section">
          <p className="muted small">Settled up, so it cannot be changed.</p>
          <div className="receipt" style={{ marginTop: "var(--space-4)" }}>
            <p className="title">
              {name(bill.paidByMemberId, bill.paidByName)} paid {formatCents(bill.totalCents)}
            </p>
            {bill.shares.map((s) => (
              <div key={s.memberId} className="row">
                <span>{name(s.memberId, s.name)}</span>
                <span className="leader" />
                <span className="amt">{formatCents(s.shareCents)}</span>
              </div>
            ))}
          </div>
        </section>
      ) : (
        <>
          <section className="section">
            <BillForm
              members={members}
              meId={member.id}
              action={editBillAction}
              billId={bill.id}
              initial={{
                description: bill.description,
                total: typed(bill.totalCents),
                paidBy: bill.paidByMemberId,
                split: bill.splitKind,
                sharers: bill.shares.map((s) => s.memberId),
                subtotal: bill.subtotalCents === null ? "" : typed(bill.subtotalCents),
                own:
                  bill.splitKind === "receipt"
                    ? Object.fromEntries(
                        bill.shares
                          .filter((s) => s.ownCents !== null)
                          .map((s) => [s.memberId, typed(s.ownCents ?? 0)]),
                      )
                    : {},
                lines: bill.items.map((i) => ({
                  name: i.name,
                  price: typed(i.priceCents),
                  who: i.memberIds,
                })),
                pct: Object.fromEntries(
                  bill.shares
                    .filter((s) => s.percentBp !== null)
                    .map((s) => [s.memberId, String(Number(((s.percentBp ?? 0) / 100).toFixed(2)))]),
                ),
              }}
            />
          </section>
          <section className="section">
            <form action={deleteBillAction}>
              <input type="hidden" name="billId" value={bill.id} />
              <SubmitButton className="btn btn-danger btn-block" pendingLabel="Deleting…">
                Delete bill
              </SubmitButton>
            </form>
            <p className="small muted" style={{ marginTop: "var(--space-2)" }}>
              Deleting puts everyone's balance back. It shows in the activity feed.
            </p>
          </section>
        </>
      )}
      <p className="small" style={{ marginTop: "var(--space-4)" }}>
        <Link href="/bills" className="muted">
          Back to bills
        </Link>
      </p>
    </main>
  );
}
