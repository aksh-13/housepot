"use server";

import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import { endSession, normalizePhone, requestCode, setUserName, verifyCode } from "@/domain/auth";
import { createChore, ensureTurns, updateChore } from "@/domain/chores";
import { raiseDispute, voteDispute } from "@/domain/disputes";
import { createHouse, joinHouse, memberById, setAutoReload, setPaused } from "@/domain/houses";
import { memberBalance } from "@/domain/ledger";
import { applyPaymentEvent, startCheckout } from "@/domain/payments";
import { savePhoto } from "@/domain/photos";
import { leaveHouse, markPayoutSent, voteClosePot } from "@/domain/settlement";
import { claimBounty, markDone, payToSkip } from "@/domain/turns";
import { textBountyOpen } from "@/domain/views";
import {
  baseUrl,
  clearSessionCookie,
  currentUser,
  requireMember,
  requireUser,
  setSessionCookie,
} from "@/lib/current";
import { isOperator } from "@/lib/operator";
import { safeNext } from "@/lib/session";
import { formatCents } from "@/money";
import { getProviders, paymentsAreFake } from "@/providers";
import type { Schedule } from "@/time";

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();
const dollarsToCents = (value: string) => Math.round(Number(value) * 100);

/** Goes back to a page with a one-line message shown at the top. */
function back(path: string, kind: "error" | "notice", message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}${kind}=${encodeURIComponent(message)}`);
}

// ── Signing in ────────────────────────────────────────────────────────────────

export async function requestCodeAction(fd: FormData): Promise<void> {
  const next = safeNext(str(fd, "next"));
  const nextParam = `next=${encodeURIComponent(next)}`;
  const phone = normalizePhone(str(fd, "phone"));
  if (!phone) back(`/login?${nextParam}`, "error", "That does not look like a phone number.");
  const sent = await requestCode(getDb(), getProviders().sms, phone, new Date());
  const step2 = `/login?phone=${encodeURIComponent(phone)}&${nextParam}`;
  if (!sent.ok) back(step2, "error", sent.error ?? "Could not send a code.");
  redirect(step2);
}

export async function verifyCodeAction(fd: FormData): Promise<void> {
  const next = safeNext(str(fd, "next"));
  const phone = normalizePhone(str(fd, "phone"));
  if (!phone) redirect("/login");
  const session = await verifyCode(getDb(), phone, str(fd, "code"), new Date());
  if (!session) {
    back(
      `/login?phone=${encodeURIComponent(phone)}&next=${encodeURIComponent(next)}`,
      "error",
      "That code is wrong or has expired.",
    );
  }
  await setSessionCookie(session.sessionToken);
  redirect(next);
}

export async function signOutAction(): Promise<void> {
  const token = await clearSessionCookie();
  if (token) await endSession(getDb(), token);
  redirect("/");
}

// ── Starting and joining a house ──────────────────────────────────────────────

async function ensureName(userId: string, current: string | null, given: string): Promise<boolean> {
  if (given) await setUserName(getDb(), userId, given);
  return Boolean(given || current);
}

export async function createHouseAction(fd: FormData): Promise<void> {
  const user = await requireUser("/new");
  if (!(await ensureName(user.id, user.name, str(fd, "name")))) back("/new", "error", "Tell us your name.");
  const created = await createHouse(getDb(), {
    userId: user.id,
    houseName: str(fd, "houseName"),
    depositCents: dollarsToCents(str(fd, "deposit") || "20"),
    now: new Date(),
  });
  if (!created.ok) back("/new", "error", created.error);
  redirect("/house");
}

export async function joinHouseAction(fd: FormData): Promise<void> {
  const code = str(fd, "code");
  const path = `/join/${encodeURIComponent(code)}`;
  const user = await requireUser(path);
  if (!(await ensureName(user.id, user.name, str(fd, "name")))) back(path, "error", "Tell us your name.");
  const joined = await joinHouse(getDb(), { userId: user.id, inviteCode: code, now: new Date() });
  if (!joined.ok) back(path, "error", joined.error);
  redirect("/house");
}

// ── Paying in ─────────────────────────────────────────────────────────────────

export async function payAction(fd: FormData): Promise<void> {
  const { member } = await requireMember();
  const saveCard = fd.get("saveCard") === "on";
  if (saveCard) await setAutoReload(getDb(), member.id, true);
  const started = await startCheckout(getDb(), getProviders().payments, {
    memberId: member.id,
    saveCard,
    baseUrl: await baseUrl(),
  });
  if ("error" in started) back("/house", "error", started.error);
  redirect(started.url);
}

/** The "Pay" button on the pretend checkout page. Only exists while payments are fake. */
export async function fakePayAction(fd: FormData): Promise<void> {
  if (!paymentsAreFake()) notFound();
  let payload: { event: unknown; successUrl?: string };
  try {
    payload = JSON.parse(Buffer.from(str(fd, "p"), "base64url").toString());
  } catch {
    back("/house", "error", "That checkout link is broken.");
  }
  const event = await getProviders().payments.parseWebhook(JSON.stringify(payload.event), "fake");
  if (!event || event === "ignored") back("/house", "error", "That checkout link is broken.");
  // Only the signed-in member may complete their own pretend payment.
  const { member } = await requireMember();
  if (event.memberId !== member.id) back("/house", "error", "That checkout belongs to someone else.");
  await applyPaymentEvent(getDb(), event, new Date());
  redirect("/house?notice=Payment%20received.");
}

// ── Turns ─────────────────────────────────────────────────────────────────────

async function photoFrom(fd: FormData, houseId: string, memberId: string) {
  const file = fd.get("photo");
  if (!(file instanceof File) || file.size === 0) {
    return { ok: false as const, error: "Add a photo of the finished chore." };
  }
  return savePhoto(getDb(), getProviders().storage, {
    houseId,
    memberId,
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
    now: new Date(),
  });
}

export async function doneAction(fd: FormData): Promise<void> {
  const { member, house } = await requireMember();
  const photo = await photoFrom(fd, house.id, member.id);
  if (!photo.ok) back("/house", "error", photo.error);
  const now = new Date();
  const done = await markDone(getDb(), {
    turnId: str(fd, "turnId"),
    memberId: member.id,
    photoId: photo.photoId,
    now,
  });
  if (!done.ok) back("/house", "error", done.error);
  await ensureTurns(getDb(), house.id, now);
  back(
    "/house",
    "notice",
    done.payoutCents
      ? `Done. You collected ${formatCents(done.payoutCents)} left on the chore.`
      : "Done. Nice one.",
  );
}

export async function skipAction(fd: FormData): Promise<void> {
  const { member, house } = await requireMember();
  const db = getDb();
  const turnId = str(fd, "turnId");
  const now = new Date();
  const skipped = await payToSkip(db, { turnId, memberId: member.id, now });
  if (!skipped.ok) back("/house", "error", skipped.error);
  const turn = await db.query<{ chore_id: string; name: string }>(
    "select t.chore_id, c.name from turns t join chores c on c.id = t.chore_id where t.id = $1",
    [turnId],
  );
  if (turn.rows[0]) {
    await textBountyOpen(db, getProviders().sms, {
      houseId: house.id,
      choreId: turn.rows[0].chore_id,
      choreName: turn.rows[0].name,
      exceptMemberId: member.id,
      link: `${await baseUrl()}/house`,
    });
  }
  await ensureTurns(db, house.id, now);
  back(
    "/house",
    "notice",
    "Skipped. It is open to the house now, and you can still win it back by doing it.",
  );
}

export async function claimAction(fd: FormData): Promise<void> {
  const { member, house } = await requireMember();
  const photo = await photoFrom(fd, house.id, member.id);
  if (!photo.ok) back("/house", "error", photo.error);
  const claimed = await claimBounty(getDb(), {
    turnId: str(fd, "turnId"),
    memberId: member.id,
    photoId: photo.photoId,
    now: new Date(),
  });
  if (!claimed.ok) back("/house", "error", claimed.error);
  back("/house", "notice", `Claimed. ${formatCents(claimed.payoutCents ?? 0)} is yours.`);
}

// ── Disputes ──────────────────────────────────────────────────────────────────

async function textDisputePassed(accusedMemberId: string, choreName: string): Promise<void> {
  const db = getDb();
  const accused = await memberById(db, accusedMemberId);
  if (!accused) return;
  const balance = formatCents(await memberBalance(db, accusedMemberId));
  await getProviders()
    .sms.send(
      accused.phone,
      `The house voted that ${choreName} was not done. Your balance is now ${balance}. ${await baseUrl()}/house`,
    )
    .catch((err) => console.error("Dispute text failed:", err));
}

export async function disputeAction(fd: FormData): Promise<void> {
  const { member } = await requireMember();
  const raised = await raiseDispute(getDb(), {
    turnId: str(fd, "turnId"),
    memberId: member.id,
    now: new Date(),
  });
  if (!raised.ok) back("/house", "error", raised.error);
  if (raised.passed) await textDisputePassed(raised.accusedMemberId, raised.choreName);
  back(
    "/house",
    "notice",
    raised.passed ? "Dispute upheld. The chore is open again." : "Dispute raised. Your housemates can vote.",
  );
}

export async function voteAction(fd: FormData): Promise<void> {
  const { member } = await requireMember();
  const voted = await voteDispute(getDb(), {
    disputeId: str(fd, "disputeId"),
    memberId: member.id,
    agree: str(fd, "agree") === "yes",
    now: new Date(),
  });
  if (!voted.ok) back("/house", "error", voted.error);
  if (voted.passed) await textDisputePassed(voted.accusedMemberId, voted.choreName);
  back("/house", "notice", voted.passed ? "Dispute upheld. The chore is open again." : "Vote counted.");
}

// ── Chores ────────────────────────────────────────────────────────────────────

function scheduleFrom(fd: FormData): Schedule {
  if (str(fd, "scheduleKind") === "every_n_days") {
    return { kind: "every_n_days", n: Number(str(fd, "everyN")), anchorDate: str(fd, "anchorDate") };
  }
  return { kind: "weekly", weekday: Number(str(fd, "weekday")) };
}

export async function addChoreAction(fd: FormData): Promise<void> {
  const { member, house } = await requireMember("/house/chores");
  const now = new Date();
  const created = await createChore(getDb(), {
    houseId: house.id,
    memberId: member.id,
    name: str(fd, "name"),
    schedule: scheduleFrom(fd),
    deadlineTime: str(fd, "deadlineTime"),
    skipPriceCents: dollarsToCents(str(fd, "skipPrice") || "5"),
    now,
  });
  if (!created.ok) back("/house/chores", "error", created.error);
  await ensureTurns(getDb(), house.id, now);
  back("/house/chores", "notice", "Chore added.");
}

export async function updateChoreAction(fd: FormData): Promise<void> {
  const { member, house } = await requireMember("/house/chores");
  const now = new Date();
  const updated = await updateChore(getDb(), {
    choreId: str(fd, "choreId"),
    memberId: member.id,
    name: str(fd, "name"),
    schedule: scheduleFrom(fd),
    deadlineTime: str(fd, "deadlineTime"),
    skipPriceCents: dollarsToCents(str(fd, "skipPrice")),
    now,
  });
  if (!updated.ok) back("/house/chores", "error", updated.error);
  await ensureTurns(getDb(), house.id, now);
  back("/house/chores", "notice", "Chore saved.");
}

export async function archiveChoreAction(fd: FormData): Promise<void> {
  const { member } = await requireMember("/house/chores");
  const archived = await updateChore(getDb(), {
    choreId: str(fd, "choreId"),
    memberId: member.id,
    archived: true,
    now: new Date(),
  });
  if (!archived.ok) back("/house/chores", "error", archived.error);
  back("/house/chores", "notice", "Chore removed.");
}

// ── Settings ──────────────────────────────────────────────────────────────────

export async function pauseAction(fd: FormData): Promise<void> {
  const { member, house } = await requireMember("/house/settings");
  const paused = str(fd, "paused") === "yes";
  const now = new Date();
  const result = await setPaused(getDb(), { houseId: house.id, memberId: member.id, paused, now });
  if (!result.ok) back("/house/settings", "error", result.error);
  if (!paused) await ensureTurns(getDb(), house.id, now);
  back(
    "/house/settings",
    "notice",
    paused ? "House paused. Nothing is charged until someone resumes it." : "House resumed.",
  );
}

export async function autoReloadAction(fd: FormData): Promise<void> {
  const { member } = await requireMember("/house/settings");
  const on = str(fd, "on") === "yes";
  await setAutoReload(getDb(), member.id, on);
  back("/house/settings", "notice", on ? "Auto-reload is on." : "Auto-reload is off.");
}

export async function closeVoteAction(): Promise<void> {
  const { member } = await requireMember("/house/settings");
  const result = await voteClosePot(getDb(), getProviders().payments, {
    memberId: member.id,
    now: new Date(),
  });
  if (result.closed) back("/house", "notice", "The pot is closed and everyone has been cashed out.");
  back("/house/settings", "notice", `Vote counted: ${result.votes} of ${result.needed} needed.`);
}

export async function leaveAction(): Promise<void> {
  const { member } = await requireMember("/house/settings");
  const left = await leaveHouse(getDb(), getProviders().payments, { memberId: member.id, now: new Date() });
  if (!left.ok) back("/house/settings", "error", left.error);
  redirect("/?notice=You%20left%20the%20house%20and%20were%20cashed%20out.");
}

// ── Operator ──────────────────────────────────────────────────────────────────

export async function markSentAction(fd: FormData): Promise<void> {
  const user = await currentUser();
  if (!user || !isOperator(user.phone)) notFound();
  await markPayoutSent(getDb(), str(fd, "id"), new Date());
  redirect("/operator");
}
