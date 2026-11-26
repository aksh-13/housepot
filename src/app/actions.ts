"use server";

import { notFound, redirect } from "next/navigation";
import { getDb } from "@/db";
import { endSession, normalizePhone, requestCode, setUserName, verifyCode } from "@/domain/auth";
import { billInputFromForm, createBill, deleteBill, editBill } from "@/domain/bills";
import { createChore, ensureTurns, updateChore } from "@/domain/chores";
import { raiseDispute, voteDispute } from "@/domain/disputes";
import { fakeReceivedEmail, fakeRequestEmail } from "@/domain/fakeInterac";
import {
  createHouse,
  joinHouse,
  memberById,
  normalizeEmail,
  setAutoReload,
  setPaused,
  setPayoutDetails,
} from "@/domain/houses";
import { forwardingAddress, handleInboundEmail, type InboundEmail } from "@/domain/inbound";
import { memberBalance } from "@/domain/ledger";
import { applyPaymentEvent, startCheckout } from "@/domain/payments";
import { savePhoto } from "@/domain/photos";
import { leaveHouse, markPayoutSent, voteClosePot } from "@/domain/settlement";
import {
  debtById,
  markDebtPaid,
  markDebtSent,
  settleUpHouse,
  settleUpNow,
  settleUpWith,
  textDebtPaid,
  textNewDebts,
} from "@/domain/settleup";
import { addNudge, addTeam, removeNudge, removeTeam, saveTeams, sendNudge } from "@/domain/teams";
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
import { getProviders, inboundIsFake, paymentsAreFake } from "@/providers";
import { cardHousesOn, signInBy } from "@/settings";
import type { Schedule } from "@/time";

const str = (fd: FormData, key: string) => String(fd.get(key) ?? "").trim();
const dollarsToCents = (value: string) => Math.round(Number(value) * 100);

/** Goes back to a page with a one-line message shown at the top. */
function back(path: string, kind: "error" | "notice", message: string): never {
  const sep = path.includes("?") ? "&" : "?";
  redirect(`${path}${sep}${kind}=${encodeURIComponent(message)}`);
}

// ── Signing in ────────────────────────────────────────────────────────────────

/** What the person typed, as the address a code goes to: an email or a phone number, by setting. */
const signInAddress = (typed: string): string | null =>
  signInBy() === "email" ? normalizeEmail(typed) : normalizePhone(typed);

export async function requestCodeAction(fd: FormData): Promise<void> {
  const next = safeNext(str(fd, "next"));
  const nextParam = `next=${encodeURIComponent(next)}`;
  const to = signInAddress(str(fd, "to"));
  if (!to) {
    const what = signInBy() === "email" ? "an email address" : "a phone number";
    back(`/login?${nextParam}`, "error", `That does not look like ${what}.`);
  }
  const sent = await requestCode(getDb(), getProviders().sms, to, new Date());
  const step2 = `/login?to=${encodeURIComponent(to)}&${nextParam}`;
  if (!sent.ok) back(step2, "error", sent.error ?? "Could not send a code.");
  redirect(step2);
}

export async function verifyCodeAction(fd: FormData): Promise<void> {
  const next = safeNext(str(fd, "next"));
  const to = signInAddress(str(fd, "to"));
  if (!to) redirect("/login");
  const session = await verifyCode(getDb(), to, str(fd, "code"), new Date());
  if (!session) {
    back(
      `/login?to=${encodeURIComponent(to)}&next=${encodeURIComponent(next)}`,
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
    moneyMode: str(fd, "moneyMode") === "card" ? "card" : "etransfer",
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

/** Settings: change the name housemates see. */
export async function renameAction(fd: FormData): Promise<void> {
  const { user } = await requireMember("/house/settings");
  const name = str(fd, "name");
  if (!name) back("/house/settings", "error", "Your name cannot be empty.");
  await setUserName(getDb(), user.id, name);
  back("/house/settings", "notice", "Name saved.");
}

// ── Paying in ─────────────────────────────────────────────────────────────────

export async function payAction(fd: FormData): Promise<void> {
  if (!cardHousesOn()) notFound();
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
  if (!paymentsAreFake() || !cardHousesOn()) notFound();
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
      accused.contact,
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
    firstMemberId: str(fd, "firstMemberId") || undefined,
    teamDuty: str(fd, "doneBy") === "team",
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
    // The field is only on the form when the house has teams; without it, leave the chore as it is.
    teamDuty: fd.has("doneBy") ? str(fd, "doneBy") === "team" : undefined,
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
  const { member, house } = await requireMember("/house/settings");
  const result = await voteClosePot(getDb(), getProviders().payments, {
    memberId: member.id,
    now: new Date(),
  });
  if (result.closed && house.moneyMode === "etransfer") {
    await textNewDebts(getDb(), getProviders().sms, result.debts ?? [], `${await baseUrl()}/settle`);
    back("/settle", "notice", "The house settled up. Here is who pays whom.");
  }
  if (result.closed) back("/house", "notice", "The pot is closed and everyone has been cashed out.");
  back("/house/settings", "notice", `Vote counted: ${result.votes} of ${result.needed} needed.`);
}

export async function leaveAction(): Promise<void> {
  const { member, house } = await requireMember("/house/settings");
  const left = await leaveHouse(getDb(), getProviders().payments, { memberId: member.id, now: new Date() });
  if (!left.ok) back("/house/settings", "error", left.error);
  if (house.moneyMode === "etransfer") {
    await textNewDebts(getDb(), getProviders().sms, left.debts ?? [], `${await baseUrl()}/settle`);
    redirect(
      "/settle?notice=You%20left%20the%20house.%20The%20house%20settled%20up%3A%20here%20is%20what%20is%20left%20to%20pay.",
    );
  }
  redirect("/?notice=You%20left%20the%20house%20and%20were%20cashed%20out.");
}

// ── Cleaning teams ────────────────────────────────────────────────────────────

export async function addTeamAction(): Promise<void> {
  const { member, house } = await requireMember("/teams");
  const now = new Date();
  const added = await addTeam(getDb(), { houseId: house.id, memberId: member.id, now });
  if (!added.ok) back("/teams", "error", added.error);
  await ensureTurns(getDb(), house.id, now);
  back("/teams", "notice", "Team added. Put people on it below.");
}

export async function removeTeamAction(fd: FormData): Promise<void> {
  const { member, house } = await requireMember("/teams");
  const now = new Date();
  const removed = await removeTeam(getDb(), { teamId: str(fd, "teamId"), memberId: member.id, now });
  if (!removed.ok) back("/teams", "error", removed.error);
  await ensureTurns(getDb(), house.id, now);
  back("/teams", "notice", "Team removed.");
}

/** The Teams form: rotation length, start date, team names (name:<teamId>) and who is on which (team:<memberId>). */
export async function saveTeamsAction(fd: FormData): Promise<void> {
  const { member, house } = await requireMember("/teams");
  const names: Record<string, string> = {};
  const assignments: Record<string, string | null> = {};
  for (const [key, value] of fd.entries()) {
    if (key.startsWith("name:")) names[key.slice(5)] = String(value);
    if (key.startsWith("team:")) assignments[key.slice(5)] = String(value) || null;
  }
  const now = new Date();
  const saved = await saveTeams(getDb(), {
    houseId: house.id,
    memberId: member.id,
    weeks: Number(str(fd, "weeks")),
    startDate: str(fd, "startDate"),
    names,
    assignments,
    now,
  });
  if (!saved.ok) back("/teams", "error", saved.error);
  await ensureTurns(getDb(), house.id, now);
  back("/teams", "notice", "Teams saved.");
}

export async function addNudgeAction(fd: FormData): Promise<void> {
  const { member, house } = await requireMember("/teams");
  const added = await addNudge(getDb(), {
    houseId: house.id,
    memberId: member.id,
    label: str(fd, "label"),
    now: new Date(),
  });
  if (!added.ok) back("/teams", "error", added.error);
  back("/teams", "notice", "Nudge added.");
}

export async function removeNudgeAction(fd: FormData): Promise<void> {
  const { member } = await requireMember("/teams");
  const removed = await removeNudge(getDb(), { nudgeId: str(fd, "nudgeId"), memberId: member.id });
  if (!removed.ok) back("/teams", "error", removed.error);
  back("/teams", "notice", "Nudge removed.");
}

/** A nudge button on the House page: tells the team on duty. */
export async function nudgeAction(fd: FormData): Promise<void> {
  const { member } = await requireMember("/house");
  const sent = await sendNudge(getDb(), getProviders().sms, {
    nudgeId: str(fd, "nudgeId"),
    memberId: member.id,
    now: new Date(),
    link: `${await baseUrl()}/house`,
  });
  if (!sent.ok) back("/house", "error", sent.error);
  back(
    "/house",
    "notice",
    sent.sentTo === 0
      ? `Noted. You are the only one on ${sent.teamName}, so nobody else was told.`
      : `${sent.teamName} has been told.`,
  );
}

// ── Bills ─────────────────────────────────────────────────────────────────────

/** Bills only exist in houses that settle up by e-Transfer. */
async function requireBillsHouse(next: string) {
  const session = await requireMember(next);
  if (session.house.moneyMode !== "etransfer") notFound();
  return session;
}

export async function addBillAction(fd: FormData): Promise<void> {
  const { member, house } = await requireBillsHouse("/bills/new");
  const parsed = billInputFromForm(fd);
  if (!parsed.ok) back("/bills/new", "error", parsed.error);
  const added = await createBill(getDb(), {
    houseId: house.id,
    actorMemberId: member.id,
    input: parsed.input,
    clientToken: str(fd, "token") || undefined,
    now: new Date(),
  });
  if (!added.ok) back("/bills/new", "error", added.error);
  back("/bills", "notice", "Bill added.");
}

export async function editBillAction(fd: FormData): Promise<void> {
  const billId = str(fd, "billId");
  const path = `/bills/${encodeURIComponent(billId)}`;
  const { member } = await requireBillsHouse(path);
  const parsed = billInputFromForm(fd);
  if (!parsed.ok) back(path, "error", parsed.error);
  const edited = await editBill(getDb(), {
    billId,
    actorMemberId: member.id,
    input: parsed.input,
    now: new Date(),
  });
  if (!edited.ok) back(path, "error", edited.error);
  back("/bills", "notice", "Bill updated.");
}

export async function deleteBillAction(fd: FormData): Promise<void> {
  const { member } = await requireBillsHouse("/bills");
  const deleted = await deleteBill(getDb(), {
    billId: str(fd, "billId"),
    actorMemberId: member.id,
    now: new Date(),
  });
  if (!deleted.ok) back("/bills", "error", deleted.error);
  back("/bills", "notice", "Bill deleted.");
}

// ── Settling up by e-Transfer ─────────────────────────────────────────────────

export async function savePayoutAction(fd: FormData): Promise<void> {
  const { member } = await requireMember("/house/settings");
  const saved = await setPayoutDetails(getDb(), {
    memberId: member.id,
    etransferEmail: str(fd, "etransferEmail"),
    bank: str(fd, "bank"),
  });
  if (!saved.ok) back("/house/settings", "error", saved.error);
  back(str(fd, "back") === "settle" ? "/settle" : "/house/settings", "notice", "Saved.");
}

/** "Settle up now": turns the balances into payments straight away. Any housemate, no vote. */
export async function settleNowAction(): Promise<void> {
  const { member, house } = await requireMember("/house");
  const settled = await settleUpNow(getDb(), { houseId: house.id, memberId: member.id, now: new Date() });
  if (!settled.ok) back("/house", "error", settled.error);
  await textNewDebts(getDb(), getProviders().sms, settled.debts, `${await baseUrl()}/settle`);
  back("/settle", "notice", "Payments requested. Everyone who owes has been emailed.");
}

/** "Settle" on one line of the To square up list: just the two people on it, right now. */
export async function settleWithAction(fd: FormData): Promise<void> {
  const { member, house } = await requireMember("/house");
  const settled = await settleUpWith(getDb(), {
    houseId: house.id,
    memberId: member.id,
    otherMemberId: str(fd, "otherMemberId"),
    now: new Date(),
  });
  if (!settled.ok) back("/house", "error", settled.error);
  await textNewDebts(getDb(), getProviders().sms, [settled.debt], `${await baseUrl()}/settle`);
  const iPay = settled.debt.fromMemberId === member.id;
  back(
    "/settle",
    "notice",
    iPay
      ? "Here is how to pay. Press I've paid when it is sent."
      : "Payment requested. They have been emailed.",
  );
}

/** Either person on a debt says it is paid. Nobody has to confirm. */
export async function debtPaidAction(fd: FormData): Promise<void> {
  const user = await requireUser("/settle");
  const paid = await markDebtPaid(getDb(), {
    debtId: str(fd, "debtId"),
    via: "manual",
    userId: user.id,
    now: new Date(),
  });
  if (!paid.ok) back("/settle", "error", paid.error);
  if (paid.changed) {
    const by = paid.debt.fromUserId === user.id ? "payer" : "receiver";
    await textDebtPaid(getProviders().sms, paid.debt, `${await baseUrl()}/settle`, by);
  }
  back("/settle", "notice", "Marked as paid.");
}

// ── Development only: pretend Interac ─────────────────────────────────────────

/** Sends a pretend Interac email through the same code a real one goes through. */
async function deliverFake(email: InboundEmail): Promise<string> {
  const origin = await baseUrl();
  const handled = await handleInboundEmail(getDb(), email, new Date(), {
    extraHosts: [new URL(origin).host],
  });
  if (handled.paid) await textDebtPaid(getProviders().sms, handled.paid, `${origin}/settle`);
  return handled.outcome;
}

/** /dev/inbox: Interac tells the receiver the money arrived, or tells the payer they were asked for it. */
export async function fakeInteracEmailAction(fd: FormData): Promise<void> {
  if (!inboundIsFake()) notFound();
  const debt = await debtById(getDb(), str(fd, "debtId"));
  if (!debt) back("/dev/inbox", "error", "No such debt.");
  const withCode = str(fd, "withCode") !== "no";
  const message = withCode ? `Housepot ${debt.code}` : "chores";
  const origin = await baseUrl();
  const email =
    str(fd, "kind") === "request"
      ? fakeRequestEmail({
          to: await forwardingAddress(getDb(), debt.fromUserId),
          requesterName: debt.toName,
          amountCents: debt.amountCents,
          message,
          url: `${origin}/dev/fake-interac/${debt.id}`,
        })
      : fakeReceivedEmail({
          to: await forwardingAddress(getDb(), debt.toUserId),
          senderName: debt.fromName.toUpperCase(),
          amountCents: debt.amountCents,
          message,
        });
  back("/dev/inbox", "notice", `Delivered. Outcome: ${await deliverFake(email)}.`);
}

/** The pretend Interac request page's "Accept" button: the money moves, and Interac emails the receiver. */
export async function fakeInteracAcceptAction(fd: FormData): Promise<void> {
  if (!inboundIsFake()) notFound();
  const user = await requireUser("/settle");
  const debt = await debtById(getDb(), str(fd, "debtId"));
  if (!debt || debt.fromUserId !== user.id) back("/settle", "error", "That request is not for you.");
  await markDebtSent(getDb(), { debtId: debt.id, userId: user.id, now: new Date() });
  const outcome = await deliverFake(
    fakeReceivedEmail({
      to: await forwardingAddress(getDb(), debt.toUserId),
      senderName: debt.fromName.toUpperCase(),
      amountCents: debt.amountCents,
      message: `Housepot ${debt.code}`,
    }),
  );
  back(
    "/settle",
    "notice",
    outcome === "paid" ? "Paid. Interac's email cleared it automatically." : `Sent (${outcome}).`,
  );
}

/** Runs a settle-up now, for trying the flow without waiting for the 1st. */
export async function devSettleNowAction(): Promise<void> {
  if (!inboundIsFake()) notFound();
  const { house } = await requireMember("/dev/inbox");
  const debts = await settleUpHouse(getDb(), { houseId: house.id, now: new Date(), reason: "early" });
  await textNewDebts(getDb(), getProviders().sms, debts, `${await baseUrl()}/settle`);
  back(
    "/settle",
    "notice",
    debts.length ? `Settled up: ${debts.length} payment(s).` : "Everyone is even: nothing to pay.",
  );
}

// ── Operator ──────────────────────────────────────────────────────────────────

export async function markSentAction(fd: FormData): Promise<void> {
  const user = await currentUser();
  if (!user || !isOperator(user)) notFound();
  await markPayoutSent(getDb(), str(fd, "id"), new Date());
  redirect("/operator");
}
