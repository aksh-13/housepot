-- Signing in by email. A person has a phone number, an email, or both.
alter table users alter column phone drop not null;
alter table users add column email text unique;
alter table users add constraint users_reachable check (phone is not null or email is not null);
-- One-time codes go to a phone number or an email address.
alter table otp_codes rename column phone to address;

-- Bills are locked once a settle-up has turned them into debts.
alter table houses add column last_settled_at timestamptz;

-- A shared bill. The money itself lives in the ledger; these tables say what the bill was.
create table bills (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references houses(id) on delete cascade,
  description text not null,
  total_cents int not null check (total_cents between 1 and 1000000),
  -- Set for a receipt split (the amount before tax and tip). Null for an equal split.
  subtotal_cents int check (subtotal_cents between 1 and 1000000),
  paid_by_member_id uuid not null references members(id),
  created_by_member_id uuid not null references members(id),
  -- Goes up by one on every edit. Part of each ledger ref, so an edit can be told from the original.
  revision int not null default 1,
  -- Sent by the form so a double submit makes one bill.
  client_token text unique,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  deleted_at timestamptz
);
create index bills_house on bills (house_id, created_at desc);

create table bill_shares (
  bill_id uuid not null references bills(id) on delete cascade,
  member_id uuid not null references members(id),
  -- Receipt splits only: what this person's own items came to before tax. Null when nothing was typed.
  own_cents int check (own_cents >= 0),
  share_cents int not null check (share_cents >= 0),
  primary key (bill_id, member_id)
);
