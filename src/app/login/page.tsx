import Link from "next/link";
import { redirect } from "next/navigation";
import { requestCodeAction, verifyCodeAction } from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { Flash, PlainMasthead, param } from "@/components/frame";
import { currentUser } from "@/lib/current";
import { safeNext } from "@/lib/session";
import { smsIsFake } from "@/providers";
import { signInBy } from "@/settings";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

export default async function LoginPage({ searchParams }: Props) {
  const params = await searchParams;
  const next = safeNext(param(params.next));
  if (await currentUser()) redirect(next);
  const to = param(params.to);
  const byEmail = signInBy() === "email";

  return (
    <main className="shell">
      <PlainMasthead />
      <Flash params={params} />
      <section className="section">
        <h1 className="house-name">{to ? "Enter your code" : "Sign in"}</h1>
        <p className="muted small" style={{ margin: "var(--space-2) 0 var(--space-5)" }}>
          {to
            ? `We ${byEmail ? "emailed" : "texted"} a 6-digit code to ${to}. It works for 10 minutes.`
            : `No password. We ${byEmail ? "email" : "text"} you a code each time.`}
        </p>

        {to ? (
          <form action={verifyCodeAction}>
            <input type="hidden" name="to" value={to} />
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
                {byEmail ? "Use a different email" : "Use a different number"}
              </Link>
            </p>
            {smsIsFake() && (
              <p className="small muted" style={{ marginTop: "var(--space-2)" }}>
                Messages are switched off here. <Link href="/dev/outbox">Read the code in the outbox.</Link>
              </p>
            )}
          </form>
        ) : (
          <form action={requestCodeAction}>
            <input type="hidden" name="next" value={next} />
            <div className="field">
              <label htmlFor="to">{byEmail ? "Email" : "Mobile number"}</label>
              {byEmail ? (
                <input
                  id="to"
                  name="to"
                  className="input"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder="you@example.com"
                  required
                />
              ) : (
                <input
                  id="to"
                  name="to"
                  className="input"
                  type="tel"
                  inputMode="tel"
                  autoComplete="tel"
                  placeholder="905 555 0100"
                  required
                />
              )}
            </div>
            <SubmitButton className="btn btn-primary btn-block" pendingLabel="Sending…">
              {byEmail ? "Email me a code" : "Text me a code"}
            </SubmitButton>
          </form>
        )}
      </section>
    </main>
  );
}
