create extension if not exists pgcrypto;

create type public.app_role as enum (
  'super_admin',
  'management',
  'branch_admin',
  'teacher',
  'admission_counsellor',
  'accountant',
  'parent'
);

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  code text not null unique,
  address text,
  phone text,
  timezone text not null default 'Asia/Kolkata',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null,
  phone text,
  avatar_path text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.user_memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  branch_id uuid references public.branches(id) on delete cascade,
  role public.app_role not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint branch_required_for_scoped_roles check (
    role in ('super_admin', 'management') or branch_id is not null
  )
);

create unique index user_memberships_unique_active_scope
  on public.user_memberships (user_id, role, coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where is_active = true;

create index user_memberships_user_idx on public.user_memberships(user_id) where is_active = true;
create index user_memberships_branch_idx on public.user_memberships(branch_id) where is_active = true;

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references public.profiles(id) on delete set null,
  branch_id uuid references public.branches(id) on delete set null,
  event_type text not null,
  entity_type text,
  entity_id uuid,
  request_id text,
  metadata jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now()
);

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name)
  values (
    new.id,
    coalesce(
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.phone, ''),
      nullif(split_part(coalesce(new.email, ''), '@', 1), ''),
      'OctoMinds User'
    )
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_auth_user();

alter table public.branches enable row level security;
alter table public.profiles enable row level security;
alter table public.user_memberships enable row level security;
alter table public.audit_events enable row level security;

create policy profiles_read_self on public.profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_update_self on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy memberships_read_self on public.user_memberships
  for select to authenticated using (user_id = auth.uid() and is_active = true);

create policy branches_read_assigned on public.branches
  for select to authenticated using (
    exists (
      select 1 from public.user_memberships membership
      where membership.user_id = auth.uid()
        and membership.is_active = true
        and (membership.branch_id = branches.id or membership.role in ('super_admin', 'management'))
    )
  );

create policy audit_events_insert_authenticated on public.audit_events
  for insert to authenticated with check (actor_user_id = auth.uid());

revoke all on public.audit_events from anon;
grant select, update on public.profiles to authenticated;
grant select on public.user_memberships to authenticated;
grant select on public.branches to authenticated;
grant insert on public.audit_events to authenticated;
