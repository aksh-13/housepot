import { randomUUID } from "node:crypto";
import Link from "next/link";
import { notFound } from "next/navigation";
import { addBillAction } from "@/app/actions";
import { BillForm } from "@/components/bill-form";
import { Flash, Masthead } from "@/components/frame";
import { getDb } from "@/db";
import { activeMembers } from "@/domain/houses";
import { requireMember } from "@/lib/current";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Add a shared bill: who paid, who shares it, and how it is split. */
export default async function NewBillPage({ searchParams }: Props) {
  const { member, house } = await requireMember("/bills/new");
  if (house.moneyMode !== "etransfer") notFound();
  const members = (await activeMembers(getDb(), house.id)).map((m) => ({ id: m.id, name: m.name }));

  return (
    <main className="shell">
      <Masthead current="bills" settle />
      <Flash params={await searchParams} />
      <h1 className="house-name">Add a bill</h1>
      <section className="section">
        <BillForm
          members={members}
          meId={member.id}
          action={addBillAction}
          token={randomUUID()}
          initial={{
            description: "",
            total: "",
            paidBy: member.id,
            split: "equal",
            sharers: members.map((m) => m.id),
            subtotal: "",
            own: {},
          }}
        />
        <p className="small" style={{ marginTop: "var(--space-4)" }}>
          <Link href="/bills" className="muted">
            Back to bills
          </Link>
        </p>
      </section>
    </main>
  );
}
