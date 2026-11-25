import nodemailer from "nodemailer";
import type { Sms } from "./sms";

/**
 * Email senders. They implement the same interface as text messages (send to an address, with a
 * body), so the rest of the app does not care which one is carrying its messages.
 */

const SUBJECT_MAX = 60;
/**
 * How long a send may take. A host that blocks outgoing mail leaves the connection hanging; without
 * a limit, someone asking for a sign-in code would wait minutes and then see the host's error page.
 */
export const SEND_TIMEOUT_MS = 10_000;

/**
 * A subject line from a message body: the first sentence, stopping before a link is introduced.
 * "Your Housepot code is 123456. It works for 10 minutes." becomes "Housepot: Your Housepot code is 123456".
 */
export function subjectFor(body: string): string {
  const firstSentence = body.split(/\. |: /)[0].replace(/\.$/, "");
  return `Housepot: ${firstSentence.slice(0, SUBJECT_MAX)}`;
}

type SmtpEnv = {
  SMTP_HOST: string;
  SMTP_PORT: string;
  SMTP_USER: string;
  SMTP_PASS: string;
  EMAIL_FROM: string;
};

/** Connection settings for any SMTP server. With Gmail: smtp.gmail.com, port 465, and an app password. */
export function smtpOptions(env: SmtpEnv) {
  const port = Number(env.SMTP_PORT);
  return {
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: SEND_TIMEOUT_MS,
    greetingTimeout: SEND_TIMEOUT_MS,
    socketTimeout: SEND_TIMEOUT_MS,
  };
}

/** Sends through any SMTP server. */
export function smtpEmail(env: SmtpEnv): Sms {
  const transport = nodemailer.createTransport(smtpOptions(env));
  return {
    async send(to, body) {
      await transport.sendMail({ from: env.EMAIL_FROM, to, subject: subjectFor(body), text: body });
    },
  };
}

type ResendEnv = { RESEND_API_KEY: string; EMAIL_FROM: string };

/** Sends through Resend's HTTPS API. Needs a domain verified with Resend for EMAIL_FROM. */
export function resendEmail(env: ResendEnv, fetchFn: typeof fetch = fetch): Sms {
  return {
    async send(to, body) {
      const res = await fetchFn("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [to], subject: subjectFor(body), text: body }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Resend refused the email to ${to}: ${res.status} ${await res.text()}`);
    },
  };
}
