import Link from "next/link";
import { redirect } from "next/navigation";
import { requestCodeAction, verifyCodeAction } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { Flash, PlainMasthead, param } from "@/components/frame";
import { currentUser } from "@/lib/current";
import { safeNext } from "@/lib/session";
import { smsIsFake } from "@/providers";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeNext(param(params.next));
  if (await currentUser()) redirect(next);
  const phone = param(params.phone);

  return (
    <main className="shell">
      <PlainMasthead />
      <Flash params={params} />
      <section className="section">
        <h1 className="house-name">{phone ? "Enter your code" : "Sign in"}</h1>
        <p className="muted small" style={{ margin: "var(--space-2) 0 var(--space-5)" }}>
          {phone
            ? `We texted a 6-digit code to ${phone}. It works for 10 minutes.`
            : "No password. We text you a code each time."}
        </p>

        {phone ? (
          <form action={verifyCodeAction}>
            <input type="hidden" name="phone" value={phone} />
            <input type="hidden" name="next" value={next} />
            <div className="field">
              <label htmlFor="code">Code</label>
              <input
                id="code"
                name="code"
                className="input input-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                // biome-ignore lint/a11y/noAutofocus: the code is the only thing to do on this screen
                autoFocus
              />
            </div>
            <SubmitButton className="btn btn-primary btn-block" pendingLabel="Checking…">
              Sign in
            </SubmitButton>
            <p className="small" style={{ marginTop: "var(--space-4)" }}>
              <Link href={`/login?next=${encodeURIComponent(next)}`} className="muted">
                Use a different number
              </Link>
            </p>
            {smsIsFake() && (
              <p className="small muted" style={{ marginTop: "var(--space-2)" }}>
                Texts are switched off here. <Link href="/dev/outbox">Read the code in the outbox.</Link>
              </p>
            )}
          </form>
        ) : (
          <form action={requestCodeAction}>
            <input type="hidden" name="next" value={next} />
            <div className="field">
              <label htmlFor="phone">Mobile number</label>
              <input
                id="phone"
                name="phone"
                className="input"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder="905 555 0100"
                required
              />
            </div>
            <SubmitButton className="btn btn-primary btn-block" pendingLabel="Sending…">
              Text me a code
            </SubmitButton>
          </form>
        )}
      </section>
    </main>
  );
}
