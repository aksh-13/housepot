-- Settling up by e-Transfer: the app keeps score and housemates pay each other directly.
-- A house is either 'card' (deposits held by card, the original design) or 'etransfer'
-- (no money held: balances are a scoreboard, settled between housemates every month).
alter table houses
  add column money_mode text not null default 'card' check (money_mode in ('card', 'etransfer'));

-- Where a housemate receives e-Transfers, and which bank they use (for the "open my bank" button).
alter table members
  add column etransfer_email text,
  add column bank text;

-- The private part of a person's forwarding address (pay-<token>@...), for Interac emails.
alter table users add column inbound_token text unique;
-- The last Gmail forwarding confirmation code that arrived at that address, so it can be shown.
alter table users add column forwarding_code text;

-- Who pays whom after a settle-up. The ledger has already moved both balances to zero when a row is
-- created; this table tracks the real e-Transfer outside the app.
create table debts (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  from_member_id uuid not null references members(id),
  to_member_id uuid not null references members(id),
  amount_cents int not null check (amount_cents > 0),
  -- Goes in the e-Transfer message so the payment can be matched automatically.
  code text not null unique,
  status text not null default 'owed' check (status in ('owed', 'sent', 'paid')),
  paid_via text check (paid_via in ('email', 'manual')),
  -- The Interac "request money" link, once one has been seen by the payer's forwarding address.
  request_url text,
  due_at timestamptz not null,
  sent_at timestamptz,
  paid_at timestamptz,
  reminders int not null default 0,
  created_at timestamptz not null default now(),
  check (from_member_id <> to_member_id)
);
create index debts_house on debts (house_id, status);
create index debts_from on debts (from_member_id) where status <> 'paid';
create index debts_to on debts (to_member_id) where status <> 'paid';

-- Every email that reached a forwarding address, kept for checking what happened.
create table inbound_emails (
  id uuid primary key default gen_random_uuid(),
  message_id text not null unique,
  user_id uuid references users(id),
  from_address text not null,
  subject text not null,
  authenticated boolean not null,
  kind text not null,
  debt_id uuid references debts(id),
  outcome text not null,
  received_at timestamptz not null default now()
);
