import { ScheduleFields } from "@/components/buttons";
import type { Chore } from "@/domain/chores";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** The fields shared by "add a chore", "edit a chore" and the first-run walkthrough. */
export function ChoreFields({
  chore,
  today,
  idPrefix,
  hasTeams,
}: {
  chore?: Chore;
  today: string;
  idPrefix: string;
  hasTeams: boolean;
}) {
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
      {hasTeams && (
        <div className="field">
          <label htmlFor={id("doneBy")}>Who does it</label>
          <select
            id={id("doneBy")}
            name="doneBy"
            className="input"
            defaultValue={(chore ? chore.teamDuty : true) ? "team" : "person"}
          >
            <option value="team">The team on duty</option>
            <option value="person">One person at a time, round the whole house</option>
          </select>
          <span className="hint">
            A team chore is given to someone on the team on duty. Anyone on that team can do it, and if it
            expires its worth is shared by the team.
          </span>
        </div>
      )}
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
          <label htmlFor={id("price")}>Worth ($)</label>
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
