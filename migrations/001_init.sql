create extension if not exists pgcrypto;

create table users (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  name text,
  created_at timestamptz not null default now()
);

create table otp_codes (
  phone text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  last_sent_at timestamptz not null
);

create table sessions (
  token_hash text primary key,
  user_id uuid not null references users(id) on delete cascade,
  expires_at timestamptz not null
);

create table houses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  deposit_cents int not null check (deposit_cents > 0),
  tz text not null default 'America/Toronto',
  paused boolean not null default false,
  settlement_date date not null,
  created_at timestamptz not null default now()
);

create table members (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  user_id uuid not null references users(id),
  status text not null default 'pending' check (status in ('pending', 'active', 'left')),
  rotation_position int not null,
  auto_reload boolean not null default false,
  customer_ref text,
  topup_requested_month text,
  joined_at timestamptz not null default now()
);
-- One house per person: at most one membership that has not been left.
create unique index members_one_house_per_user on members (user_id) where status <> 'left';
create index members_house on members (house_id);

create table chores (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  name text not null,
  schedule_kind text not null check (schedule_kind in ('weekly', 'every_n_days')),
  weekday int check (weekday between 1 and 7),
  every_n int check (every_n >= 1),
  anchor_date date,
  deadline_time text not null check (deadline_time ~ '^[0-2][0-9]:[0-5][0-9]$'),
  skip_price_cents int not null check (skip_price_cents > 0),
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index chores_house on chores (house_id);

create table photos (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  member_id uuid not null references members(id),
  storage_key text not null,
  content_type text not null,
  created_at timestamptz not null default now()
);

create table turns (
  id uuid primary key default gen_random_uuid(),
  chore_id uuid not null references chores(id) on delete cascade,
  house_id uuid not null references houses(id) on delete cascade,
  assignee_member_id uuid not null references members(id),
  due_at timestamptz not null,
  status text not null default 'assigned'
    check (status in ('assigned', 'done', 'open', 'claimed', 'rolled', 'cancelled')),
  opened_reason text check (opened_reason in ('skip', 'miss', 'dispute')),
  completed_by_member_id uuid references members(id),
  completed_at timestamptz,
  photo_id uuid references photos(id),
  payout_cents int not null default 0,
  reminded_morning_at timestamptz,
  reminded_final_at timestamptz,
  created_at timestamptz not null default now()
);
create index turns_house_status on turns (house_id, status);
create index turns_chore on turns (chore_id, due_at);
-- A chore has at most one turn waiting to be done.
create unique index turns_one_assigned_per_chore on turns (chore_id) where status = 'assigned';

create table transfers (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  kind text not null,
  turn_id uuid references turns(id),
  ref text unique,
  created_at timestamptz not null default now()
);

-- Double entry: every transfer has two rows that add up to zero.
create table ledger_entries (
  id bigserial primary key,
  transfer_id uuid not null references transfers(id) on delete cascade,
  house_id uuid not null references houses(id) on delete cascade,
  account_type text not null check (account_type in ('member', 'chore', 'external')),
  member_id uuid references members(id),
  chore_id uuid references chores(id),
  amount_cents int not null,
  created_at timestamptz not null default now(),
  check (
    (account_type = 'member' and member_id is not null and chore_id is null) or
    (account_type = 'chore' and chore_id is not null and member_id is null) or
    (account_type = 'external' and member_id is null and chore_id is null)
  )
);
create index ledger_member on ledger_entries (member_id) where member_id is not null;
create index ledger_chore on ledger_entries (chore_id) where chore_id is not null;
create index ledger_house on ledger_entries (house_id);

create table payments (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references members(id),
  provider_ref text not null unique,
  amount_cents int not null,
  fee_cents int not null,
  purpose text not null,
  refunded_cents int not null default 0,
  created_at timestamptz not null default now()
);

create table disputes (
  id uuid primary key default gen_random_uuid(),
  turn_id uuid not null unique references turns(id) on delete cascade,
  house_id uuid not null references houses(id) on delete cascade,
  raised_by_member_id uuid not null references members(id),
  accused_member_id uuid not null references members(id),
  status text not null default 'open' check (status in ('open', 'passed', 'expired')),
  created_at timestamptz not null default now()
);

create table dispute_votes (
  dispute_id uuid not null references disputes(id) on delete cascade,
  member_id uuid not null references members(id),
  agree boolean not null,
  primary key (dispute_id, member_id)
);

create table close_votes (
  house_id uuid not null references houses(id) on delete cascade,
  member_id uuid not null references members(id),
  primary key (house_id, member_id)
);

create table manual_payouts (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  member_id uuid not null references members(id),
  amount_cents int not null,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create table activity (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  member_id uuid references members(id),
  kind text not null,
  data jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index activity_house on activity (house_id, created_at desc);

create table sms_outbox (
  id bigserial primary key,
  to_phone text not null,
  body text not null,
  created_at timestamptz not null default now()
);
