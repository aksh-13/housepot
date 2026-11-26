-- Cleaning teams. A house can split into teams that take turns being on duty: one team for a set
-- number of weeks, then the next. Chores marked for "the team on duty" belong to that whole team.

create table teams (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  name text not null,
  -- The order teams come on duty in.
  position int not null,
  created_at timestamptz not null default now()
);
create index teams_house on teams (house_id, position);

-- A housemate is on at most one team. Null: not on a team, so never on duty.
alter table members add column team_id uuid references teams(id) on delete set null;

-- How long each team is on duty, and the day the first team's first stint began. Both null: the
-- house does not use teams.
alter table houses
  add column team_weeks int check (team_weeks between 1 and 8),
  add column team_start date;

-- True: each turn of this chore belongs to the team on duty when it is due, not to one person.
alter table chores add column team_duty boolean not null default false;

-- Set on a turn that belongs to a team. assignee_member_id still names one member of that team,
-- the teammate it is given to (named and reminded). Who may do it
-- and who pays for a miss both come from the team, not from that person.
alter table turns add column team_id uuid references teams(id) on delete set null;

-- One-tap messages to the team on duty, like "Garbage is full".
create table nudges (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  label text not null,
  -- For the once-an-hour limit.
  last_sent_at timestamptz,
  created_at timestamptz not null default now()
);
create index nudges_house on nudges (house_id, created_at);
