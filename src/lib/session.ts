import { getDb } from "@/db";
import { sessionUser, type User } from "@/domain/auth";

export const SESSION_COOKIE = "hp_session";
export const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

/** Pulls the session token out of a raw Cookie header. */
export function tokenFromCookieHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/** The signed-in user for a plain Request (API routes), or null. */
export async function userFromRequest(req: Request): Promise<User | null> {
  const token = tokenFromCookieHeader(req.headers.get("cookie"));
  return token ? sessionUser(getDb(), token, new Date()) : null;
}

/** Only same-site paths are allowed as a place to send someone after signing in. */
export function safeNext(next: string | null | undefined, fallback = "/"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
