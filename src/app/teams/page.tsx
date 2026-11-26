import { DateTime } from "luxon";
import {
  addNudgeAction,
  addTeamAction,
  assignTurnAction,
  removeNudgeAction,
  removeTeamAction,
  saveTeamsAction,
} from "@/app/actions";
import { SubmitButton } from "@/components/buttons";
import { Flash, Masthead } from "@/components/frame";
import { getDb } from "@/db";
import { activeMembers } from "@/domain/houses";
import { DEFAULT_TEAM_WEEKS, listNudges, listTeams, MAX_TEAM_WEEKS, teamOnDuty } from "@/domain/teams";
import { houseTurns } from "@/domain/views";
import { requireMember } from "@/lib/current";
import { dateLabel, dueLabel } from "@/lib/format";
import { localDate } from "@/time";

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Cleaning teams: who is on which team, how long each is on duty, and the nudges the house uses. */
export default async function TeamsPage({ searchParams }: Props) {
  const { member, house } = await requireMember("/teams");
  const db = getDb();
  const now = new Date();
  const [teams, housemates, nudges, duty, turns] = await Promise.all([
    listTeams(db, house.id),
    activeMembers(db, house.id),
    listNudges(db, house.id),
    teamOnDuty(db, house.id, now),
    houseTurns(db, house.id),
  ]);
  const teamTurns = turns.filter((t) => t.status === "assigned" && t.teamId);
  const canEdit = member.status === "active";
  const thisMonday = DateTime.fromISO(localDate(now, house.tz)).startOf("week").toISODate() ?? "";
  const unassigned = housemates.filter((m) => !m.teamId);

  return (
    <main className="shell">
      <Masthead current="teams" settle={house.moneyMode === "etransfer"} />
      <Flash params={await searchParams} />
      <h1 className="house-name">Teams</h1>
      <p className="muted small" style={{ marginTop: "var(--space-2)" }}>
        Split the house into cleaning teams that take turns being on duty. A chore set to "the team on duty"
        belongs to that whole team: anyone on it can do it, and a miss is shared between them.
      </p>

      {teams.length === 0 ? (
        <section className="section">
          <p className="empty">This house does not use teams yet. Chores go to one person at a time.</p>
          {canEdit && (
            <form action={addTeamAction} style={{ marginTop: "var(--space-4)" }}>
              <SubmitButton className="btn btn-primary btn-block" pendingLabel="Adding…">
                Start with a first team
              </SubmitButton>
            </form>
          )}
        </section>
      ) : (
        <>
          <section className="section">
            <h2 className="label">On duty now</h2>
            {duty ? (
              <>
                <div className="row">
                  <span>{duty.team.name}</span>
                  <span className="leader" />
                  <span className="small muted">until {dateLabel(duty.until)}</span>
                </div>
                <p className="small muted">
                  {duty.team.memberNames.length > 0
                    ? duty.team.memberNames.join(", ")
                    : "Nobody is on this team yet, so its chores go to one person at a time."}
                </p>
              </>
            ) : (
              <p className="empty">Set the rotation below.</p>
            )}
          </section>

          {teamTurns.length > 0 && (
            <section className="section">
              <h2 className="label">Who has what</h2>
              <p className="small muted">
                Team chores are spread across the team automatically. Change who has one here.
              </p>
              {teamTurns.map((turn) => {
                const team = teams.find((t) => t.id === turn.teamId);
                return (
                  <form key={turn.id} action={assignTurnAction} className="row">
                    <input type="hidden" name="turnId" value={turn.id} />
                    <input type="hidden" name="back" value="teams" />
                    <label htmlFor={`has-${turn.id}`}>
                      {turn.choreName}{" "}
                      <span className="muted small">· {dueLabel(turn.dueAt, now, house.tz)}</span>
                    </label>
                    <span className="leader" />
                    <select
                      id={`has-${turn.id}`}
                      name="toMemberId"
                      className="input team-pick"
                      defaultValue={turn.assigneeMemberId}
                      disabled={!canEdit}
                    >
                      {(team?.memberIds ?? []).map((id, i) => (
                        <option key={id} value={id}>
                          {team?.memberNames[i]}
                        </option>
                      ))}
                    </select>
                    {canEdit && (
                      <span className="row-action">
                        <SubmitButton className="btn btn-small" pendingLabel="…">
                          Give
                        </SubmitButton>
                      </span>
                    )}
                  </form>
                );
              })}
            </section>
          )}

          <section className="section">
            <h2 className="label">Teams and rotation</h2>
            <form action={saveTeamsAction}>
              <div className="pair">
                <div className="field">
                  <label htmlFor="weeks">Each team is on for</label>
                  <select
                    id="weeks"
                    name="weeks"
                    className="input"
                    defaultValue={house.teamWeeks ?? DEFAULT_TEAM_WEEKS}
                    disabled={!canEdit}
                  >
                    {Array.from({ length: MAX_TEAM_WEEKS }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n === 1 ? "1 week" : `${n} weeks`}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="startDate">{teams[0].name} started on</label>
                  <input
                    id="startDate"
                    name="startDate"
                    className="input"
                    type="date"
                    defaultValue={house.teamStart ?? thisMonday}
                    disabled={!canEdit}
                    required
                  />
                </div>
              </div>
              <p className="small muted" style={{ marginBottom: "var(--space-4)" }}>
                Teams come on duty in the order below, then start again from the top.
              </p>

              {teams.map((team) => (
                <div key={team.id} className="field">
                  <label htmlFor={`name-${team.id}`}>Team name</label>
                  <input
                    id={`name-${team.id}`}
                    name={`name:${team.id}`}
                    className="input"
                    defaultValue={team.name}
                    maxLength={30}
                    disabled={!canEdit}
                    required
                  />
                  <span className="hint">
                    {team.memberNames.length > 0 ? team.memberNames.join(", ") : "Nobody on this team yet."}
                  </span>
                </div>
              ))}

              <fieldset className="field">
                <legend className="legend">Who is on which team</legend>
                {housemates.map((m) => (
                  <div key={m.id} className="row">
                    <label htmlFor={`team-${m.id}`}>{m.id === member.id ? `${m.name} (you)` : m.name}</label>
                    <span className="leader" />
                    <select
                      id={`team-${m.id}`}
                      name={`team:${m.id}`}
                      className="input team-pick"
                      defaultValue={m.teamId ?? ""}
                      disabled={!canEdit}
                    >
                      <option value="">No team</option>
                      {teams.map((team) => (
                        <option key={team.id} value={team.id}>
                          {team.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                {unassigned.length > 0 && (
                  <span className="hint">
                    {unassigned.length === 1
                      ? `${unassigned[0].name} is not on a team, so is never on duty.`
                      : `${unassigned.length} people are not on a team, so are never on duty.`}
                  </span>
                )}
              </fieldset>
              {canEdit && (
                <SubmitButton className="btn btn-primary btn-block" pendingLabel="Saving…">
                  Save teams
                </SubmitButton>
              )}
            </form>
            {canEdit && (
              <div className="actions" style={{ marginTop: "var(--space-3)" }}>
                <form action={addTeamAction}>
                  <SubmitButton pendingLabel="Adding…">Add another team</SubmitButton>
                </form>
              </div>
            )}
            {canEdit &&
              teams.map((team) => (
                <form key={team.id} action={removeTeamAction} style={{ marginTop: "var(--space-2)" }}>
                  <input type="hidden" name="teamId" value={team.id} />
                  <SubmitButton className="btn-quiet" pendingLabel="Removing…">
                    Remove {team.name}
                  </SubmitButton>
                </form>
              ))}
            <p className="small muted" style={{ marginTop: "var(--space-3)" }}>
              Changing teams restarts any team chore that is waiting, so it lands on the right team. Anyone in
              the house can change teams, and every change shows in the activity feed.
            </p>
          </section>

          <section className="section">
            <h2 className="label">Nudges</h2>
            <p className="small muted">
              One-tap messages to the team on duty, sent from the House page. Each can go out once an hour.
            </p>
            {nudges.map((nudge) => (
              <div key={nudge.id} className="row">
                <span>{nudge.label}</span>
                <span className="leader" />
                {canEdit && (
                  <form action={removeNudgeAction} className="row-action">
                    <input type="hidden" name="nudgeId" value={nudge.id} />
                    <SubmitButton className="btn btn-small" pendingLabel="…">
                      Remove
                    </SubmitButton>
                  </form>
                )}
              </div>
            ))}
            {canEdit && (
              <form action={addNudgeAction} style={{ marginTop: "var(--space-3)" }}>
                <div className="field">
                  <label htmlFor="label">Add a nudge</label>
                  <div className="invite">
                    <input
                      id="label"
                      name="label"
                      className="input"
                      placeholder="Dishes are piling up"
                      maxLength={40}
                      required
                    />
                    <SubmitButton pendingLabel="Adding…">Add</SubmitButton>
                  </div>
                </div>
              </form>
            )}
          </section>
        </>
      )}
    </main>
  );
}
