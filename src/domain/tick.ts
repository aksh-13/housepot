import { DateTime } from "luxon";
import type { Db } from "@/db";
import { feeCents, formatCents } from "@/money";
import type { Payments } from "@/providers/payments";
import type { Sms } from "@/providers/sms";
import { localDate } from "@/time";
import { logActivity } from "./activity";
import { closeTimedOutSubmissions } from "./approvals";
import { ensureTurns } from "./chores";
import { activeMembers, HOUSE_COLUMNS, type House, type Member } from "./houses";
import { choreBounty, memberBalance } from "./ledger";
import { applyPaymentEvent } from "./payments";
import { settleHouse } from "./settlement";
import { FIRST_REMINDER_MS, howToPay } from "./settleup";
import { missTurn } from "./turns";
import { closeOldProposals } from "./worth";

const TICK_LOCK_KEY = 4827002;
const FINAL_REMINDER_MS = 2 * 60 * 60_000;
const MORNING_HOUR = 8;
/** Top-up requests go out in the first days of the month, so a missed tick on the 1st is not fatal. */
const TOPUP_REQUEST_LAST_DAY = 3;

export type TickSummary = {
  turnsCreated: number;
  reminders: number;
  misses: number;
  topupRequests: number;
  autoReloads: number;
  settled: number;
  /** e-Transfer houses: debts created by settle-ups, and payment reminders sent. */
  debtsCreated: number;
  debtReminders: number;
  /** Proof that waited 48 hours with no majority either way, so it counted. */
  approvalsClosed: number;
  errors: number;
  /** Another tick was already running, so this one did nothing. */
  skippedLocked?: true;
};

type Providers = { sms: Sms; payments: Payments };
type Ctx = { db: Db; p: Providers; now: Date; link: string; settleLink: string; summary: TickSummary };

/** A text that fails to send must never stop money from being handled correctly. */
async function send(ctx: Ctx, to: string, body: string): Promise<void> {
  try {
    await ctx.p.sms.send(to, body);
  } catch (err) {
    console.error(`Text to ${to} failed:`, err instanceof Error ? err.message : err);
  }
}

async function chargeMisses(ctx: Ctx, house: House, members: Member[]): Promise<void> {
  const overdue = await ctx.db.query<{
    id: string;
    chore_id: string;
    assignee_member_id: string;
    team_id: string | null;
    name: string;
  }>(
    `select t.id, t.chore_id, t.assignee_member_id, t.team_id, c.name
     from turns t join chores c on c.id = t.chore_id
     where t.house_id = $1 and t.status = 'assigned' and t.due_at < $2
       and not exists (select 1 from submissions s where s.turn_id = t.id and s.status = 'pending')
     order by t.due_at`,
    [house.id, ctx.now],
  );
  for (const turn of overdue.rows) {
    const missed = await missTurn(ctx.db, { turnId: turn.id, now: ctx.now });
    if (!missed.ok) continue;
    ctx.summary.misses += 1;
    const bounty = formatCents(await choreBounty(ctx.db, turn.chore_id));
    for (const m of members) {
      if (turn.team_id && m.teamId === turn.team_id) {
        const balance = formatCents(await memberBalance(ctx.db, m.id));
        await send(
          ctx,
          m.contact,
          `Your team missed ${turn.name}. The ${bounty} was split between everyone on the team, and your balance is now ${balance}. It is open to the house now: whoever does it takes it. ${ctx.link}`,
        );
      } else if (!turn.team_id && m.id === turn.assignee_member_id) {
        const balance = formatCents(await memberBalance(ctx.db, m.id));
        await send(
          ctx,
          m.contact,
          `You missed ${turn.name}. ${bounty} moved out of your balance (now ${balance}). It is open to the house now: whoever does it takes it. ${ctx.link}`,
        );
      } else {
        await send(
          ctx,
          m.contact,
          `${turn.name} is open: +${bounty} to whoever does it, with a photo. ${ctx.link}`,
        );
      }
    }
  }
}

async function sendReminders(ctx: Ctx, house: House, members: Member[]): Promise<void> {
  const waiting = await ctx.db.query<{
    id: string;
    assignee_member_id: string;
    team_id: string | null;
    due_at: Date;
    name: string;
    reminded_morning_at: Date | null;
    reminded_final_at: Date | null;
  }>(
    `select t.id, t.assignee_member_id, t.team_id, t.due_at, c.name, t.reminded_morning_at, t.reminded_final_at
     from turns t join chores c on c.id = t.chore_id
     where t.house_id = $1 and t.status = 'assigned' and t.due_at >= $2
       and not exists (select 1 from submissions s where s.turn_id = t.id and s.status = 'pending')`,
    [house.id, ctx.now],
  );
  const nowLocal = DateTime.fromJSDate(ctx.now, { zone: house.tz });
  for (const turn of waiting.rows) {
    // A team's turn reminds everyone on the team; anyone's turn reminds that one person.
    const remind = turn.team_id
      ? members.filter((m) => m.teamId === turn.team_id)
      : members.filter((m) => m.id === turn.assignee_member_id);
    if (remind.length === 0) continue;
    const whose = turn.team_id ? "your team's" : "yours";
    const has = members.find((m) => m.id === turn.assignee_member_id)?.name;
    const options = turn.team_id
      ? `${has ? `${has} has it, and anyone` : "Anyone"} on the team can do it with a photo`
      : "Send a photo when it is done";
    const dueLocal = DateTime.fromJSDate(turn.due_at, { zone: house.tz });
    const by = dueLocal.toFormat("h:mm a");
    const finalDue =
      !turn.reminded_final_at && turn.due_at.getTime() - ctx.now.getTime() <= FINAL_REMINDER_MS;
    const morningDue =
      !turn.reminded_morning_at && nowLocal.hasSame(dueLocal, "day") && nowLocal.hour >= MORNING_HOUR;

    // Claim the reminder in the database before sending, so it can never go out twice.
    if (finalDue) {
      const claimed = await ctx.db.query(
        `update turns set reminded_final_at = $2, reminded_morning_at = coalesce(reminded_morning_at, $2)
         where id = $1 and reminded_final_at is null and status = 'assigned'`,
        [turn.id, ctx.now],
      );
      if (claimed.rowCount === 0) continue;
      for (const m of remind) {
        await send(ctx, m.contact, `2 hours left for ${turn.name} (by ${by}). ${options}: ${ctx.link}`);
      }
      ctx.summary.reminders += 1;
    } else if (morningDue) {
      const claimed = await ctx.db.query(
        "update turns set reminded_morning_at = $2 where id = $1 and reminded_morning_at is null and status = 'assigned'",
        [turn.id, ctx.now],
      );
      if (claimed.rowCount === 0) continue;
      for (const m of remind) {
        await send(ctx, m.contact, `${turn.name} is ${whose} today, by ${by}. ${options}: ${ctx.link}`);
      }
      ctx.summary.reminders += 1;
    }
  }
}

async function autoReload(ctx: Ctx, house: House, members: Member[]): Promise<void> {
  for (const m of members) {
    if (!m.autoReload || !m.customerRef) continue;
    const balance = await memberBalance(ctx.db, m.id);
    if (balance > 0) continue;
    const amountCents = house.depositCents - balance;
    // The key changes only when the member's ledger changes, so a retry never charges twice.
    const last = await ctx.db.query<{ id: string }>(
      "select coalesce(max(id), 0)::text as id from ledger_entries where member_id = $1",
      [m.id],
    );
    const charge = await ctx.p.payments.chargeSavedCard({
      memberId: m.id,
      customerRef: m.customerRef,
      amountCents,
      feeCents: feeCents(amountCents),
      idempotencyKey: `reload:${m.id}:${last.rows[0].id}`,
    });
    if (charge.ok) {
      await applyPaymentEvent(ctx.db, charge.event, ctx.now);
      ctx.summary.autoReloads += 1;
    } else {
      await ctx.db.query("update members set auto_reload = false where id = $1", [m.id]);
      await logActivity(ctx.db, {
        houseId: house.id,
        memberId: m.id,
        kind: "auto_reload_failed",
        now: ctx.now,
      });
      await send(ctx, m.contact, `Your card was declined, so auto-reload is off. Top up here: ${ctx.link}`);
    }
  }
}

async function requestTopups(ctx: Ctx, house: House, members: Member[]): Promise<void> {
  const nowLocal = DateTime.fromJSDate(ctx.now, { zone: house.tz });
  if (nowLocal.day > TOPUP_REQUEST_LAST_DAY) return;
  const month = nowLocal.toFormat("yyyy-MM");
  for (const m of members) {
    const balance = await memberBalance(ctx.db, m.id);
    if (balance >= house.depositCents) continue;
    const claimed = await ctx.db.query(
      "update members set topup_requested_month = $2 where id = $1 and topup_requested_month is distinct from $2",
      [m.id, month],
    );
    if (claimed.rowCount === 0) continue;
    const due = formatCents(house.depositCents - balance);
    await send(
      ctx,
      m.contact,
      `Your Housepot balance is ${formatCents(balance)}. Top up ${due} to get back to ${formatCents(house.depositCents)}: ${ctx.link}`,
    );
    ctx.summary.topupRequests += 1;
  }
}

/**
 * Nudges people who have not paid a settle-up debt: once a day after the settle-up, and once more
 * when it becomes overdue (from then on they cannot claim bounties). Each reminder is claimed in the
 * database before it is sent, so it goes out once however often the tick runs.
 */
async function remindDebts(ctx: Ctx, house: House): Promise<void> {
  const due = await ctx.db.query<{
    id: string;
    reminders: number;
    amount_cents: number;
    code: string;
    from_contact: string;
    to_name: string;
    to_email: string | null;
    overdue: boolean;
  }>(
    `select d.id, d.reminders, d.amount_cents, d.code, coalesce(fu.email, fu.phone) as from_contact,
            coalesce(tu.name, 'Housemate') as to_name, tm.etransfer_email as to_email,
            d.due_at <= $2 as overdue
     from debts d
     join members fm on fm.id = d.from_member_id join users fu on fu.id = fm.user_id
     join members tm on tm.id = d.to_member_id join users tu on tu.id = tm.user_id
     where d.house_id = $1 and d.status = 'owed'
       and ((d.reminders = 0 and d.created_at <= $3) or (d.reminders = 1 and d.due_at <= $2))`,
    [house.id, ctx.now, new Date(ctx.now.getTime() - FIRST_REMINDER_MS)],
  );
  for (const d of due.rows) {
    const next = d.overdue ? 2 : 1;
    const claimed = await ctx.db.query(
      "update debts set reminders = $2 where id = $1 and reminders < $2 and status = 'owed'",
      [d.id, next],
    );
    if (claimed.rowCount === 0) continue;
    const amount = formatCents(d.amount_cents);
    await send(
      ctx,
      d.from_contact,
      d.overdue
        ? `Your ${amount} to ${d.to_name} is overdue. You cannot win chore money until it is paid. ${howToPay(d.to_name, d.to_email, d.code)} ${ctx.settleLink}`
        : `You still owe ${d.to_name} ${amount}. ${howToPay(d.to_name, d.to_email, d.code)} ${ctx.settleLink}`,
    );
    ctx.summary.debtReminders += 1;
  }
}

async function tickEtransferHouse(ctx: Ctx, house: House): Promise<void> {
  // Nothing settles an e-Transfer house up on a date. Housemates pay or request each other when they
  // choose to, from the House page: some people take a long time to pay, and a deadline they did not
  // start only produces overdue debts. Payments someone has asked for are still chased below.
  await remindDebts(ctx, house);
  if (house.paused) return;
  await closeOldProposals(ctx.db, house.id, ctx.now);
  ctx.summary.approvalsClosed += await closeTimedOutSubmissions(ctx.db, house.id, ctx.now);
  await chargeMisses(ctx, house, await activeMembers(ctx.db, house.id));
  ctx.summary.turnsCreated += await ensureTurns(ctx.db, house.id, ctx.now);
  await sendReminders(ctx, house, await activeMembers(ctx.db, house.id));
}

async function tickHouse(ctx: Ctx, house: House): Promise<void> {
  if (house.moneyMode === "etransfer") return tickEtransferHouse(ctx, house);
  if (house.settlementDate <= localDate(ctx.now, house.tz)) {
    await settleHouse(ctx.db, ctx.p.payments, { houseId: house.id, now: ctx.now });
    ctx.summary.settled += 1;
    return;
  }
  if (house.paused) return;

  await closeOldProposals(ctx.db, house.id, ctx.now);
  ctx.summary.approvalsClosed += await closeTimedOutSubmissions(ctx.db, house.id, ctx.now);
  await chargeMisses(ctx, house, await activeMembers(ctx.db, house.id));
  ctx.summary.turnsCreated += await ensureTurns(ctx.db, house.id, ctx.now);
  const members = await activeMembers(ctx.db, house.id);
  await sendReminders(ctx, house, members);
  await autoReload(ctx, house, members);
  await requestTopups(ctx, house, members);
}

/**
 * The heartbeat, called every few minutes. Charges missed turns, hands out the next ones, sends
 * reminders, reloads cards, asks for top-ups and settles houses at the end of term.
 * Safe to call as often as you like: every step checks the database before acting.
 */
export async function runTick(db: Db, p: Providers, now: Date, baseUrl: string): Promise<TickSummary> {
  const summary: TickSummary = {
    turnsCreated: 0,
    reminders: 0,
    misses: 0,
    topupRequests: 0,
    autoReloads: 0,
    settled: 0,
    debtsCreated: 0,
    debtReminders: 0,
    approvalsClosed: 0,
    errors: 0,
  };
  // The lock lives in its own transaction; the work below uses ordinary connections.
  return db.tx(async (lockTx) => {
    const got = await lockTx.query<{ locked: boolean }>("select pg_try_advisory_xact_lock($1) as locked", [
      TICK_LOCK_KEY,
    ]);
    if (!got.rows[0].locked) return { ...summary, skippedLocked: true as const };

    const ctx: Ctx = { db, p, now, link: `${baseUrl}/house`, settleLink: `${baseUrl}/settle`, summary };
    const houses = await db.query<House>(`select ${HOUSE_COLUMNS} from houses order by created_at`);
    for (const house of houses.rows) {
      try {
        await tickHouse(ctx, house);
      } catch (err) {
        summary.errors += 1;
        console.error(`Tick failed for house ${house.id}:`, err);
      }
    }
    return summary;
  });
}
