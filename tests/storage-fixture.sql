-- Minimal Supabase Storage metadata emulation for disposable SQL tests only.
-- Production Supabase already owns this schema; never apply this fixture there.
create schema storage;
create table storage.buckets(id text primary key,name text,public boolean not null default false,file_size_limit bigint,allowed_mime_types text[]);
create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text not null,metadata jsonb default '{}',unique(bucket_id,name));
alter table storage.objects enable row level security;
grant usage on schema storage to authenticated,anon;
grant select,insert,update,delete on storage.objects to authenticated,anon;
