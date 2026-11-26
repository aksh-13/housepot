-- Who takes a chore's first turn. Chosen when the chore is added; after that it goes round the house
-- in rotation order from them. Null on chores added before this existed: those start with the first
-- housemate in the rotation, as they always did.
alter table chores add column first_member_id uuid references members(id);
