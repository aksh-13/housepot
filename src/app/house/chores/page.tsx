import { addChoreAction, archiveChoreAction, updateChoreAction } from "@/app/actions";
import { ScheduleFields, SubmitButton } from "@/components/buttons";
import { Flash, Masthead } from "@/components/frame";
import { getDb } from "@/db";
import { type Chore, listChores } from "@/domain/chores";
import { activeMembers } from "@/domain/houses";
import { houseTurns } from "@/domain/views";
import { requireMember } from "@/lib/current";
import { dueLabel, scheduleLabel, timeLabel } from "@/lib/format";
import { formatCents } from "@/money";
import { localDate } from "@/time";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The fields shared by "add a chore" and "edit a chore". */
function ChoreFields({ chore, today, idPrefix }: { chore?: Chore; today: string; idPrefix: string }) {
  const kind = chore?.schedule.kind ?? "weekly";
  const weekday = chore?.schedule.kind === "weekly" ? chore.schedule.weekday : 4;
  const everyN = chore?.schedule.kind === "every_n_days" ? chore.schedule.n : 3;
  const anchor = chore?.schedule.kind === "every_n_days" ? chore.schedule.anchorDate : today;
  const id = (name: string) => `${idPrefix}-${name}`;
  return (
    <>
      <div className="field">
        <label htmlFor={id("name")}>Chore</label>
        <input
          id={id("name")}
          name="name"
          className="input"
          defaultValue={chore?.name}
          placeholder="Take out the garbage"
          maxLength={60}
          required
        />
      </div>
      <ScheduleFields initial={kind}>
        <div className="pair">
          <div className="field">
            <label htmlFor={id("kind")}>Repeats</label>
            <select id={id("kind")} name="scheduleKind" className="input" defaultValue={kind}>
              <option value="weekly">Every week</option>
              <option value="every_n_days">Every few days</option>
            </select>
          </div>
          <div className="field only-weekly">
            <label htmlFor={id("weekday")}>On</label>
            <select id={id("weekday")} name="weekday" className="input" defaultValue={weekday}>
              {WEEKDAYS.map((day, i) => (
                <option key={day} value={i + 1}>
                  {day}
                </option>
              ))}
            </select>
          </div>
          <div className="field only-every">
            <label htmlFor={id("everyN")}>Every how many days</label>
            <input
              id={id("everyN")}
              name="everyN"
              className="input"
              type="number"
              inputMode="numeric"
              min={1}
              max={90}
              defaultValue={everyN}
            />
          </div>
        </div>
        <div className="field only-every">
          <label htmlFor={id("anchor")}>Starting</label>
          <input id={id("anchor")} name="anchorDate" className="input" type="date" defaultValue={anchor} />
        </div>
      </ScheduleFields>
      <div className="pair">
        <div className="field">
          <label htmlFor={id("time")}>Done by</label>
          <input
            id={id("time")}
            name="deadlineTime"
            className="input"
            type="time"
            defaultValue={chore?.deadlineTime ?? "21:00"}
            required
          />
        </div>
        <div className="field">
          <label htmlFor={id("price")}>Skip price ($)</label>
          <input
            id={id("price")}
            name="skipPrice"
            className="input"
            type="number"
            inputMode="decimal"
            min={1}
            max={50}
            step="0.5"
            defaultValue={(chore?.skipPriceCents ?? 500) / 100}
            required
          />
        </div>
      </div>
    </>
  );
}

export default async function ChoresPage({ searchParams }: Props) {
  const { member, house } = await requireMember("/house/chores");
  const db = getDb();
  const now = new Date();
  const [chores, housemates, turns] = await Promise.all([
    listChores(db, house.id),
    activeMembers(db, house.id),
    houseTurns(db, house.id),
  ]);
  const today = localDate(now, house.tz);
  // Whose turn each chore is right now, so the list answers "who has this one?".
  const waiting = new Map(turns.filter((t) => t.status === "assigned").map((t) => [t.choreId, t]));

  return (
    <main className="shell">
      <Masthead current="chores" settle={house.moneyMode === "etransfer"} />
      <Flash params={await searchParams} />
      <h1 className="house-name">Chores</h1>

      <section className="section">
        <h2 className="label">In rotation</h2>
        {chores.length === 0 ? (
          <p className="empty">None yet. Add the first one below, and turns start going round the house.</p>
        ) : (
          chores.map((chore) => (
            <details key={chore.id} className="editor">
              <summary>
                <span className="name">{chore.name}</span>
                <span className="small muted">
                  {scheduleLabel(chore.schedule)}, {timeLabel(chore.deadlineTime)} ·{" "}
                  {formatCents(chore.skipPriceCents)}
                  {waiting.has(chore.id) && (
                    <>
                      <br />
                      Next:{" "}
                      {waiting.get(chore.id)?.assigneeMemberId === member.id
                        ? "you"
                        : waiting.get(chore.id)?.assigneeName}
                      , {dueLabel(waiting.get(chore.id)?.dueAt ?? now, now, house.tz)}
                    </>
                  )}
                </span>
              </summary>
              <div className="body">
                <form action={updateChoreAction}>
                  <input type="hidden" name="choreId" value={chore.id} />
                  <ChoreFields chore={chore} today={today} idPrefix={chore.id} />
                  <SubmitButton className="btn btn-primary btn-block" pendingLabel="Saving…">
                    Save changes
                  </SubmitButton>
                </form>
                <form action={archiveChoreAction} style={{ marginTop: "var(--space-2)" }}>
                  <input type="hidden" name="choreId" value={chore.id} />
                  <SubmitButton className="btn-quiet" pendingLabel="Removing…">
                    Remove this chore
                  </SubmitButton>
                </form>
              </div>
            </details>
          ))
        )}
      </section>

      <section className="section">
        <h2 className="label">Add a chore</h2>
        <form action={addChoreAction}>
          <ChoreFields today={today} idPrefix="new" />
          <div className="field">
            <label htmlFor="new-first">Who goes first</label>
            <select id="new-first" name="firstMemberId" className="input" defaultValue={member.id}>
              {housemates.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id === member.id ? "Me" : m.name}
                </option>
              ))}
            </select>
            <span className="hint">
              You can give it to anyone. After the first turn it goes round the house in order.
            </span>
          </div>
          <SubmitButton className="btn btn-primary btn-block" pendingLabel="Adding…">
            Add chore
          </SubmitButton>
        </form>
        <p className="small muted" style={{ marginTop: "var(--space-3)" }}>
          Changing when a chore is due restarts its current turn. Anyone in the house can edit chores, and
          every change shows in the activity feed.
        </p>
      </section>
    </main>
  );
}
