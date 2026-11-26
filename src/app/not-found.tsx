import Link from "next/link";
import { PlainMasthead } from "@/components/frame";

/** Shown for any address that is not a page, or not one this person may see. */
export default function NotFound() {
  return (
    <main className="shell">
      <PlainMasthead />
      <section className="section">
        <h1 className="house-name">That page is not here</h1>
        <p className="muted" style={{ margin: "var(--space-2) 0 var(--space-5)" }}>
          The link may be old, or it may belong to a different house.
        </p>
        <Link href="/" className="btn btn-primary btn-block">
          Back to your house
        </Link>
      </section>
    </main>
  );
}
