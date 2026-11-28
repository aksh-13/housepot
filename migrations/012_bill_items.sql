-- Two more ways to split a bill: item by item (each line of the receipt shared by whoever had it,
-- with tax and tip following what each person had), and by percentage.

alter table bills add column split_kind text not null default 'equal'
  check (split_kind in ('equal', 'receipt', 'items', 'percent'));
update bills set split_kind = 'receipt' where subtotal_cents is not null;

-- The lines of an item-by-item bill, in receipt order.
create table bill_items (
  bill_id uuid not null references bills(id) on delete cascade,
  position int not null check (position >= 0),
  name text not null,
  price_cents int not null check (price_cents between 1 and 1000000),
  primary key (bill_id, position)
);

-- Who had each line.
create table bill_item_sharers (
  bill_id uuid not null,
  position int not null,
  member_id uuid not null references members(id),
  primary key (bill_id, position, member_id),
  foreign key (bill_id, position) references bill_items (bill_id, position) on delete cascade
);

-- A percentage split: each sharer's part, in hundredths of a percent.
alter table bill_shares add column percent_bp int check (percent_bp between 1 and 10000);
