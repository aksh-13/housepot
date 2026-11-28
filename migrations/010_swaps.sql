-- Two housemates can agree to move a turn: one asks someone to take it, optionally offering to do
-- one of theirs in exchange, and it moves only when the other person accepts.

-- Who the rotation gave this turn to, when that is not who has it now (it was swapped). The next
-- turn of the chore follows the rotation, not the swap, so a swap does not reshuffle the order.
alter table turns add column rotation_member_id uuid references members(id);

create table swap_requests (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  turn_id uuid not null references turns(id) on delete cascade,
  from_member_id uuid not null references members(id),
  to_member_id uuid not null references members(id),
  -- Optional: one of the other person's turns that the asker takes on in exchange.
  give_back_turn_id uuid references turns(id) on delete cascade,
  status text not null default 'open' check (status in ('open', 'accepted', 'declined', 'cancelled', 'lapsed')),
  created_at timestamptz not null,
  decided_at timestamptz
);
create unique index swap_requests_one_open_per_turn on swap_requests (turn_id) where status = 'open';
create index swap_requests_open_by_house on swap_requests (house_id) where status = 'open';
