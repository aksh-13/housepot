-- A refund is written down before the card processor is asked for it, so that a crash or a lost
-- reply can be retried as the same request instead of being sent, or paid by hand, a second time.
create table refund_attempts (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references payments(id),
  amount_cents int not null check (amount_cents > 0),
  status text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  created_at timestamptz not null default now()
);
create unique index refund_attempts_one_pending on refund_attempts (payment_id) where status = 'pending';

-- One dispute per completion, not per turn: a chore that is reopened by a dispute and then claimed
-- again can be disputed again.
alter table disputes add column completion_at timestamptz;
update disputes d
  set completion_at = coalesce((select t.completed_at from turns t where t.id = d.turn_id), d.created_at);
alter table disputes alter column completion_at set not null;
alter table disputes drop constraint disputes_turn_id_key;
create unique index disputes_one_per_completion on disputes (turn_id, completion_at);

-- How many sign-in codes a phone number has been sent in the current hour.
alter table otp_codes
  add column window_started_at timestamptz,
  add column sends_in_window int not null default 0;
