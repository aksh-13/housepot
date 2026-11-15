import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/db";
import { sessionUser, type User } from "@/domain/auth";
import { getHouse, type House, type Member, memberForUser } from "@/domain/houses";
import { SESSION_COOKIE, SESSION_MAX_AGE_SECONDS } from "./session";

/** The signed-in user for the current page or action, or null. */
export async function currentUser(): Promise<User | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  return token ? sessionUser(getDb(), token, new Date()) : null;
}

/** Sends the visitor to sign in (and back again) when nobody is signed in. */
export async function requireUser(next: string): Promise<User> {
  const user = await currentUser();
  if (!user) redirect(`/login?next=${encodeURIComponent(next)}`);
  return user;
}

export type HouseSession = { user: User; member: Member; house: House };

/** The signed-in user's house. People without a house are sent to the front page. */
export async function requireMember(next = "/house"): Promise<HouseSession> {
  const user = await requireUser(next);
  const member = await memberForUser(getDb(), user.id);
  if (!member) redirect("/");
  const house = await getHouse(getDb(), member.houseId);
  if (!house) redirect("/");
  return { user, member, house };
}

export async function setSessionCookie(token: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && !process.env.INSECURE_COOKIES,
    path: "/",
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
}

export async function clearSessionCookie(): Promise<string | null> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value ?? null;
  jar.delete(SESSION_COOKIE);
  return token;
}

/** The public address of the site, for links in texts and payment return pages. */
export async function baseUrl(): Promise<string> {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
