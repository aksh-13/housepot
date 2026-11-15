import type { Db } from "@/db";

export interface Sms {
  send(to: string, body: string): Promise<void>;
}

/** Saves texts to the sms_outbox table instead of sending them. Read them at /dev/outbox. */
export function fakeSms(db: Db): Sms {
  return {
    async send(to, body) {
      await db.query("insert into sms_outbox (to_phone, body) values ($1, $2)", [to, body]);
    },
  };
}

type TwilioEnv = { TWILIO_ACCOUNT_SID: string; TWILIO_AUTH_TOKEN: string; TWILIO_FROM: string };

/** Sends real texts through Twilio's REST API. */
export function twilioSms(env: TwilioEnv): Sms {
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_ACCOUNT_SID}/Messages.json`;
  const auth = Buffer.from(`${env.TWILIO_ACCOUNT_SID}:${env.TWILIO_AUTH_TOKEN}`).toString("base64");
  return {
    async send(to, body) {
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: body }),
      });
      if (!res.ok) {
        throw new Error(`Twilio refused the text to ${to}: ${res.status} ${await res.text()}`);
      }
    },
  };
}
