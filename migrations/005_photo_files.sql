-- Photo files kept in the database itself (STORAGE_PROVIDER=db), for hosts with no disk to save to
-- and no bucket set up. Proof photos are shrunk in the browser first, so each is a few hundred KB.
-- The photos table still holds who took each photo and its content type; this table is only the bytes.
create table photo_files (
  storage_key text primary key,
  bytes bytea not null,
  created_at timestamptz not null default now()
);
