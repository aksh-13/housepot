-- The first-run walkthrough is shown until a member finishes it. Everyone already in a house has
-- been using the app, so they are counted as done.
alter table members add column onboarded_at timestamptz;
update members set onboarded_at = joined_at;
