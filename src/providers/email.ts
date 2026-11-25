import nodemailer from "nodemailer";
import type { Sms } from "./sms";

/**
 * Email senders. They implement the same interface as text messages (send to an address, with a
 * body), so the rest of the app does not care which one is carrying its messages.
 */

const SUBJECT_MAX = 60;

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

/** Sends through any SMTP server. With Gmail: smtp.gmail.com, port 465, and an app password. */
export function smtpEmail(env: SmtpEnv): Sms {
  const port = Number(env.SMTP_PORT);
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
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
      });
      if (!res.ok) throw new Error(`Resend refused the email to ${to}: ${res.status} ${await res.text()}`);
    },
  };
}
