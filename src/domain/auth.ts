import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Db } from "@/db";
import type { Sms } from "@/providers/sms";

const CODE_LIFETIME_MS = 10 * 60_000;
const RESEND_WAIT_MS = 30_000;
const MAX_ATTEMPTS = 5;
const SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;

export type User = { id: string; phone: string; name: string | null };

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const hashCode = (phone: string, code: string) => sha256(`${phone}:${code}`);

/** Returns the number in +15551234567 form, or null if it is not a phone number. Ten digits are taken as +1. */
export function normalizePhone(input: string): string | null {
  const trimmed = input.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("+")) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

/** Texts a six-digit sign-in code. Refuses to send another within 30 seconds. */
export async function requestCode(
  db: Db,
  sms: Sms,
  phone: string,
  now: Date,
): Promise<{ ok: boolean; error?: string }> {
  const existing = await db.query<{ last_sent_at: Date }>(
    "select last_sent_at from otp_codes where phone = $1",
    [phone],
  );
  if (existing.rows[0] && now.getTime() - existing.rows[0].last_sent_at.getTime() < RESEND_WAIT_MS) {
    return { ok: false, error: "Please wait 30 seconds before asking for another code." };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.query(
    `insert into otp_codes (phone, code_hash, expires_at, attempts, last_sent_at) values ($1, $2, $3, 0, $4)
     on conflict (phone) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at,
       attempts = 0, last_sent_at = excluded.last_sent_at`,
    [phone, hashCode(phone, code), new Date(now.getTime() + CODE_LIFETIME_MS), now],
  );
  await sms.send(phone, `Your Housepot code is ${code}. It works for 10 minutes.`);
  return { ok: true };
}

/** Checks a code. On success the code is used up, the user exists, and a 30-day session is returned. */
export async function verifyCode(
  db: Db,
  phone: string,
  code: string,
  now: Date,
): Promise<{ userId: string; sessionToken: string } | null> {
  return db.tx(async (t) => {
    const { rows } = await t.query<{ code_hash: string; expires_at: Date; attempts: number }>(
      "select code_hash, expires_at, attempts from otp_codes where phone = $1 for update",
      [phone],
    );
    const otp = rows[0];
    if (!otp || otp.expires_at.getTime() < now.getTime() || otp.attempts >= MAX_ATTEMPTS) return null;
    if (otp.code_hash !== hashCode(phone, code.trim())) {
      await t.query("update otp_codes set attempts = attempts + 1 where phone = $1", [phone]);
      return null;
    }
    await t.query("delete from otp_codes where phone = $1", [phone]);
    const user = await t.query<{ id: string }>(
      `insert into users (phone, created_at) values ($1, $2)
       on conflict (phone) do update set phone = excluded.phone returning id`,
      [phone, now],
    );
    const userId = user.rows[0].id;
    const sessionToken = randomBytes(32).toString("base64url");
    await t.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, $3)", [
      sha256(sessionToken),
      userId,
      new Date(now.getTime() + SESSION_LIFETIME_MS),
    ]);
    return { userId, sessionToken };
  });
}

export async function sessionUser(db: Db, token: string, now: Date): Promise<User | null> {
  const { rows } = await db.query<User>(
    `select u.id, u.phone, u.name from sessions s join users u on u.id = s.user_id
     where s.token_hash = $1 and s.expires_at > $2`,
    [sha256(token), now],
  );
  return rows[0] ?? null;
}

export async function endSession(db: Db, token: string): Promise<void> {
  await db.query("delete from sessions where token_hash = $1", [sha256(token)]);
}

export async function setUserName(db: Db, userId: string, name: string): Promise<void> {
  await db.query("update users set name = $1 where id = $2", [name.trim().slice(0, 40), userId]);
}
