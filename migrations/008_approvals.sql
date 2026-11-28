-- A finished chore no longer counts the moment it is sent. It waits for the rest of the house to
-- approve it, with one or more photos as proof. This replaces the 24-hour disputes, whose tables
-- stay for history.

create table submissions (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null references turns(id) on delete cascade,
  house_id uuid not null references houses(id) on delete cascade,
  member_id uuid not null references members(id),
  -- done: the turn's own person (or team) finished it. claim: someone did an expired chore.
  kind text not null check (kind in ('done', 'claim')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  -- For a claim: the chore money set aside for it when it was sent, so a second claim on the same
  -- chore cannot be promised the same money while the first is being voted on.
  reserved_cents int not null default 0 check (reserved_cents >= 0),
  submitted_at timestamptz not null,
  decided_at timestamptz,
  -- votes: a majority decided. timeout: nobody reached a majority in time, so it counts.
  -- nobody_to_ask: a one-person house.
  decided_by text check (decided_by in ('votes', 'timeout', 'nobody_to_ask'))
);
-- One proof at a time per turn: the house votes on it before anyone else can send one.
create unique index submissions_one_pending_per_turn on submissions (turn_id) where status = 'pending';
create index submissions_pending_by_house on submissions (house_id, submitted_at) where status = 'pending';

create table submission_photos (
  submission_id uuid not null references submissions(id) on delete cascade,
  photo_id uuid not null references photos(id),
  position int not null check (position between 0 and 3),
  primary key (submission_id, position)
);

create table approval_votes (
  submission_id uuid not null references submissions(id) on delete cascade,
  member_id uuid not null references members(id),
  approve boolean not null,
  voted_at timestamptz not null,
  primary key (submission_id, member_id)
);
