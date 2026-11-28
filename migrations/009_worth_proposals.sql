-- What a chore is worth is agreed by the house. While the house has only the person who set it up,
-- they decide. After that, a new chore or a new worth for an existing one is a proposal that more
-- than half of the other housemates have to agree to, within three days.

-- Null: proposed, and waiting on the house. A chore gets no turns until it is agreed.
alter table chores add column agreed_at timestamptz;
update chores set agreed_at = created_at;

create table chore_proposals (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  chore_id uuid not null references chores(id) on delete cascade,
  proposed_by_member_id uuid not null references members(id),
  -- new: the chore itself, at this worth. worth: a new worth for a chore already in use.
  kind text not null check (kind in ('new', 'worth')),
  worth_cents int not null check (worth_cents > 0),
  status text not null default 'open' check (status in ('open', 'accepted', 'rejected', 'lapsed')),
  created_at timestamptz not null,
  decided_at timestamptz
);
-- One open proposal per chore at a time.
create unique index chore_proposals_one_open on chore_proposals (chore_id) where status = 'open';
create index chore_proposals_open_by_house on chore_proposals (house_id, created_at) where status = 'open';

create table proposal_votes (
  proposal_id uuid not null references chore_proposals(id) on delete cascade,
  member_id uuid not null references members(id),
  agree boolean not null,
  voted_at timestamptz not null,
  primary key (proposal_id, member_id)
);
