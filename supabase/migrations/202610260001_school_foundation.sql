-- Shared school setup and account administration. Additive to inventory.
begin;

alter table public.user_memberships add column expires_at timestamptz;
alter table public.branches add column email text;
alter table public.branches add column opens_at time;
alter table public.branches add column closes_at time;
alter table public.branches add column working_days integer[] not null default array[1,2,3,4,5];
alter table public.branches add column capacity integer check (capacity >= 0);
alter table public.branches add column version integer not null default 1;
alter table public.branches add constraint branch_working_days check (working_days <@ array[0,1,2,3,4,5,6]);
alter table public.branches add constraint branch_hours check (opens_at is null or closes_at is null or closes_at > opens_at);

create function public.school_has_role(p_roles public.app_role[], p_branch uuid default null)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from user_memberships m join profiles p on p.id=m.user_id
 where m.user_id=auth.uid() and m.is_active and p.is_active
 and (m.expires_at is null or m.expires_at>now()) and m.role=any(p_roles)
 and (m.role in ('super_admin','management') or (p_branch is not null and m.branch_id=p_branch)))
$$;
create function public.school_can_read(p_branch uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select school_has_role(array['super_admin','management']::app_role[]) or
 (exists(select 1 from branches where id=p_branch and is_active) and
 school_has_role(enum_range(null::app_role),p_branch))
$$;
create function public.school_can_manage(p_branch uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select school_has_role(array['super_admin','management']::app_role[]) or
 (exists(select 1 from branches where id=p_branch and is_active) and
 school_has_role(array['branch_admin']::app_role[],p_branch))
$$;
create or replace function public.has_inventory_access(target_branch_id uuid, require_write boolean default false)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from branches where id=target_branch_id and is_active) and
 school_has_role(case when require_write then array['super_admin','management','branch_admin']::app_role[]
 else array['super_admin','management','branch_admin','accountant']::app_role[] end,target_branch_id)
$$;

revoke insert,update,delete on public.branches from anon,authenticated;
drop policy branches_read_assigned on public.branches;
create policy branches_read_assigned on public.branches for select to authenticated using(school_can_read(id));
drop policy memberships_read_self on public.user_memberships;
create policy memberships_read_self on public.user_memberships for select to authenticated
 using(user_id=auth.uid() and is_active and (expires_at is null or expires_at>now()));

create table public.school_settings (
 id uuid primary key default gen_random_uuid(), singleton boolean not null default true unique check(singleton),
 name text not null check(length(trim(name)) between 1 and 120),
 email text, phone text, address text, website text,
 version integer not null default 1, updated_at timestamptz not null default now()
);
create table public.academic_years (
 id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id),
 name text not null check(length(trim(name)) between 1 and 120), starts_on date not null, ends_on date not null,
 status text not null default 'planned' check(status in ('planned','active','closed')),
 version integer not null default 1, updated_at timestamptz not null default now(),
 check(ends_on>=starts_on), unique(branch_id,name), unique(id,branch_id)
);
create unique index academic_year_one_active on public.academic_years(branch_id) where status='active';
create table public.school_terms (
 id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id),
 academic_year_id uuid not null, name text not null check(length(trim(name)) between 1 and 120),
 starts_on date not null, ends_on date not null, version integer not null default 1, updated_at timestamptz not null default now(),
 check(ends_on>=starts_on), unique(academic_year_id,name),
 foreign key(academic_year_id,branch_id) references academic_years(id,branch_id)
);
create table public.school_programs (
 id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id),
 name text not null check(length(trim(name)) between 1 and 120), description text,
 is_active boolean not null default true, version integer not null default 1, updated_at timestamptz not null default now(),
 unique(branch_id,name), unique(id,branch_id)
);
create table public.school_classes (
 id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id),
 academic_year_id uuid not null, program_id uuid not null,
 name text not null check(length(trim(name)) between 1 and 120), section text not null default '',
 room text, capacity integer not null check(capacity between 1 and 1000), is_active boolean not null default true,
 version integer not null default 1, updated_at timestamptz not null default now(),
 foreign key(academic_year_id,branch_id) references academic_years(id,branch_id),
 foreign key(program_id,branch_id) references school_programs(id,branch_id),
 unique(academic_year_id,program_id,name,section), unique(id,branch_id)
);
create table public.teacher_assignments (
 id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id),
 class_id uuid not null, user_id uuid not null references profiles(id), starts_on date not null,
 ends_on date, is_active boolean not null default true, version integer not null default 1, updated_at timestamptz not null default now(),
 check(ends_on is null or ends_on>=starts_on), foreign key(class_id,branch_id) references school_classes(id,branch_id)
);
create unique index assignment_one_active on teacher_assignments(class_id,user_id) where is_active;
create table public.school_holidays (
 id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id),
 name text not null check(length(trim(name)) between 1 and 120), starts_on date not null, ends_on date not null,
 is_active boolean not null default true, version integer not null default 1, updated_at timestamptz not null default now(),
 check(ends_on>=starts_on)
);
create table public.school_invitations (
 id uuid primary key default gen_random_uuid(), email text not null, full_name text not null,
 branch_id uuid references branches(id), role app_role not null, token_hash bytea not null unique,
 expires_at timestamptz not null default now()+interval '7 days', membership_expires_at timestamptz,
 created_by uuid not null references profiles(id), created_at timestamptz not null default now(),
 accepted_by uuid references profiles(id), accepted_at timestamptz, revoked_at timestamptz,
 check(role in ('super_admin','management') or branch_id is not null)
);

do $$ declare t text; begin
 foreach t in array array['school_settings','academic_years','school_terms','school_programs','school_classes','teacher_assignments','school_holidays','school_invitations'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from anon,authenticated',t);
  if t not in ('school_settings','school_invitations','teacher_assignments') then
   execute format('grant select on public.%I to authenticated',t);
   execute format('create policy read_scope on public.%I for select to authenticated using(public.school_can_read(branch_id))',t);
   execute format('create index on public.%I(branch_id)',t);
  end if;
 end loop;
end $$;
grant select on school_settings,teacher_assignments to authenticated;
create policy read_school on school_settings for select to authenticated using(exists(select 1 from user_memberships where user_id=auth.uid()) and exists(select 1 from profiles where id=auth.uid() and is_active));
create policy read_assignments on teacher_assignments for select to authenticated using(school_can_manage(branch_id) or (user_id=auth.uid() and school_can_read(branch_id)));

-- Validate relationships at the database boundary, including direct RPC calls.
create function public.school_record_guard() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare y academic_years; c school_classes;
begin
 if tg_table_name='branches' then
  if not exists(select 1 from pg_timezone_names where name=new.timezone) then raise exception 'Unknown timezone' using errcode='22023'; end if;
  if length(trim(new.name)) not between 1 and 120 or length(trim(new.code)) not between 1 and 20 then raise exception 'Center name and code are required' using errcode='22023'; end if;
 elsif tg_op='UPDATE' and tg_table_name<>'school_settings' then
  if new.branch_id<>old.branch_id then raise exception 'Records cannot move between centers' using errcode='22023'; end if;
 end if;
 if tg_table_name='academic_years' and tg_op='UPDATE' then
  if old.status='closed' then raise exception 'Closed academic years are read only' using errcode='22023'; end if;
  if exists(select 1 from school_terms where academic_year_id=new.id and (starts_on<new.starts_on or ends_on>new.ends_on)) then raise exception 'Year dates must contain all terms' using errcode='22023'; end if;
  if exists(select 1 from teacher_assignments a join school_classes cls on cls.id=a.class_id where cls.academic_year_id=new.id and (a.starts_on<new.starts_on or coalesce(a.ends_on,a.starts_on)>new.ends_on)) then raise exception 'Year dates must contain teacher assignments' using errcode='22023'; end if;
 end if;
 if tg_table_name in ('school_terms','school_classes') then
  select * into y from academic_years where id=new.academic_year_id for update;
  if not found or y.branch_id<>new.branch_id or y.status='closed' then raise exception 'Choose an open academic year in this center' using errcode='22023'; end if;
  if tg_op='UPDATE' and new.academic_year_id<>old.academic_year_id then raise exception 'Create a new record for another academic year' using errcode='22023'; end if;
  if tg_table_name='school_terms' then
   if new.starts_on<y.starts_on or new.ends_on>y.ends_on then raise exception 'Term dates must fall within the academic year' using errcode='22023'; end if;
  else
   if not exists(select 1 from school_programs where id=new.program_id and branch_id=new.branch_id and is_active) then raise exception 'Choose an active program in this center' using errcode='22023'; end if;
  end if;
 end if;
 if tg_table_name='teacher_assignments' then
  if tg_op='UPDATE' and (new.class_id<>old.class_id or new.user_id<>old.user_id) then raise exception 'Create a new assignment when changing class or teacher' using errcode='22023'; end if;
  select * into c from school_classes where id=new.class_id;
  select * into y from academic_years where id=c.academic_year_id for update;
  if c.id is null or c.branch_id<>new.branch_id or not c.is_active or y.status='closed' then raise exception 'Choose an active class in an open year' using errcode='22023'; end if;
  if new.starts_on<y.starts_on or new.starts_on>y.ends_on or (new.ends_on is not null and new.ends_on>y.ends_on) then raise exception 'Assignment dates must fall within the academic year' using errcode='22023'; end if;
  if new.is_active and not exists(select 1 from user_memberships m join profiles p on p.id=m.user_id where m.user_id=new.user_id and m.branch_id=new.branch_id and m.role='teacher' and m.is_active and p.is_active and (m.expires_at is null or m.expires_at>now())) then raise exception 'Teacher needs active access to this center' using errcode='22023'; end if;
 end if;
 if tg_op='UPDATE' then new.version:=old.version+1; end if;
 new.updated_at:=now(); return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['branches','school_settings','academic_years','school_terms','school_programs','school_classes','teacher_assignments','school_holidays'] loop
 execute format('create trigger school_guard before insert or update on public.%I for each row execute function school_record_guard()',t);
 end loop;
end $$;

create function public.school_save_record(p_kind text,p_data jsonb,p_id uuid default null,p_version integer default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare t text; allowed text[]; k text; cols text; vals text; assignments text; before_row jsonb; result jsonb; branch uuid;
begin
 case p_kind
 when 'school' then t:='school_settings'; allowed:=array['name','email','phone','address','website'];
 when 'centers' then t:='branches'; allowed:=array['name','code','address','phone','email','timezone','opens_at','closes_at','working_days','capacity','is_active'];
 when 'years' then t:='academic_years'; allowed:=array['branch_id','name','starts_on','ends_on','status'];
 when 'terms' then t:='school_terms'; allowed:=array['branch_id','academic_year_id','name','starts_on','ends_on'];
 when 'programs' then t:='school_programs'; allowed:=array['branch_id','name','description','is_active'];
 when 'classes' then t:='school_classes'; allowed:=array['branch_id','academic_year_id','program_id','name','section','room','capacity','is_active'];
 when 'assignments' then t:='teacher_assignments'; allowed:=array['branch_id','class_id','user_id','starts_on','ends_on','is_active'];
 when 'holidays' then t:='school_holidays'; allowed:=array['branch_id','name','starts_on','ends_on','is_active'];
 else raise exception 'Unknown school record' using errcode='22023'; end case;
 if jsonb_typeof(p_data)<>'object' or p_data='{}' then raise exception 'Record fields are required' using errcode='22023'; end if;
 for k in select jsonb_object_keys(p_data) loop
  if not k=any(allowed) then raise exception 'Unsupported record field' using errcode='22023'; end if;
 end loop;
 if p_id is not null then
  execute format('select to_jsonb(r) from public.%I r where id=$1 for update',t) into before_row using p_id;
  if before_row is null then raise exception 'Record is unavailable' using errcode='P0002'; end if;
  if p_version is null or p_version<>(before_row->>'version')::integer then raise exception 'This record changed. Reload before saving.' using errcode='40001'; end if;
 end if;
 branch:=case when p_kind='centers' then p_id else coalesce((before_row->>'branch_id')::uuid,(p_data->>'branch_id')::uuid) end;
 if p_kind='school' or (p_kind='centers' and p_id is null) then
  if not school_has_role(array['super_admin','management']::app_role[]) then raise exception 'School management access required' using errcode='42501'; end if;
 elsif not school_can_manage(branch) then raise exception 'Center administration access required' using errcode='42501'; end if;
 if p_kind='centers' and p_data ? 'is_active' and not school_has_role(array['super_admin','management']::app_role[]) then raise exception 'Only management can activate or archive centers' using errcode='42501'; end if;
 select string_agg(format('%I',key),',' order by key),
 string_agg(format('(jsonb_populate_record(null::public.%I,$1)).%I',t,key),',' order by key),
 string_agg(format('%I=(jsonb_populate_record(null::public.%I,$1)).%I',key,t,key),',' order by key)
 into cols,vals,assignments from jsonb_object_keys(p_data) key;
 if p_id is null then
  execute format('insert into public.%I (%s) select %s returning to_jsonb(%I.*)',t,cols,vals,t) into result using p_data;
 else
  execute format('update public.%I set %s where id=$2 returning to_jsonb(%I.*)',t,assignments,t) into result using p_data,p_id;
 end if;
 insert into audit_events(actor_user_id,branch_id,event_type,entity_type,entity_id,metadata)
 values(auth.uid(),case when p_kind='centers' then (result->>'id')::uuid else branch end,'school.record_saved',p_kind,(result->>'id')::uuid,jsonb_build_object('before',before_row,'after',result));
 return result;
end $$;

-- Preserve the existing inventory center endpoint while sharing the new rules.
create or replace function public.create_inventory_center(p_name text,p_code text,p_address text default null,p_phone text default null,p_timezone text default 'Asia/Kolkata')
returns table(id uuid,name text,code text,address text,phone text,timezone text,is_active boolean)
language plpgsql security definer set search_path=public,pg_temp as $$
declare r jsonb; begin
 r:=school_save_record('centers',jsonb_build_object('name',trim(p_name),'code',upper(trim(p_code)),'address',p_address,'phone',p_phone,'timezone',p_timezone));
 return query select (r->>'id')::uuid,r->>'name',r->>'code',r->>'address',r->>'phone',r->>'timezone',(r->>'is_active')::boolean;
end $$;

create function public.school_may_grant(p_role app_role,p_branch uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select (p_role in ('super_admin','management') and p_branch is null and school_has_role(array['super_admin']::app_role[]))
 or (p_role not in ('super_admin','management') and p_branch is not null
 and exists(select 1 from branches where id=p_branch and is_active)
 and (school_has_role(array['super_admin','management']::app_role[])
 or (p_role in ('teacher','admission_counsellor','accountant','parent') and school_can_manage(p_branch))))
$$;

create function public.school_access_command(p_action text,p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare target uuid; branch uuid; requested app_role; m user_memberships; inv school_invitations;
 token text; result jsonb; expiration timestamptz; mail text;
begin
 -- Serialize membership and suspension decisions, including the last-owner check.
 perform pg_advisory_xact_lock(26102601);
 if p_action='invite' then
  branch:=(p_data->>'branch_id')::uuid; requested:=(p_data->>'role')::app_role;
  if not school_may_grant(requested,branch) then raise exception 'You cannot assign this role or center' using errcode='42501'; end if;
  mail:=lower(trim(p_data->>'email')); expiration:=(p_data->>'expires_at')::timestamptz;
  if mail is null or mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(mail)>254 or length(trim(coalesce(p_data->>'full_name',''))) not between 1 and 120 then raise exception 'Enter a name and valid email' using errcode='22023'; end if;
  if expiration is not null and expiration<=now() then raise exception 'Access expiry must be in the future' using errcode='22023'; end if;
  if requested='super_admin' and expiration is not null then raise exception 'Owner access cannot expire automatically' using errcode='22023'; end if;
  token:=replace(gen_random_uuid()::text||gen_random_uuid()::text,'-','');
  insert into school_invitations(email,full_name,branch_id,role,token_hash,created_by,membership_expires_at)
  values(mail,trim(p_data->>'full_name'),branch,requested,digest(token,'sha256'),auth.uid(),expiration) returning * into inv;
  result:=jsonb_build_object('id',inv.id,'token',token,'expires_at',inv.expires_at);
 elsif p_action='revoke_invite' then
  select * into inv from school_invitations where id=(p_data->>'id')::uuid for update;
  if not found or not school_may_grant(inv.role,inv.branch_id) then raise exception 'Invitation is unavailable' using errcode='42501'; end if;
  if inv.accepted_at is not null then raise exception 'Accepted invitations cannot be revoked; remove the membership instead' using errcode='22023'; end if;
  branch:=inv.branch_id;
  update school_invitations set revoked_at=now() where id=inv.id;
  result:=jsonb_build_object('id',inv.id);
 elsif p_action in ('grant','revoke') then
  if p_action='revoke' then
   select * into m from user_memberships where id=(p_data->>'id')::uuid for update;
   if not found then raise exception 'Membership is unavailable' using errcode='P0002'; end if;
   target:=m.user_id; branch:=m.branch_id; requested:=m.role;
  else
   target:=(p_data->>'user_id')::uuid; branch:=(p_data->>'branch_id')::uuid; requested:=(p_data->>'role')::app_role;
  end if;
  if not school_may_grant(requested,case when p_action='revoke' and requested in ('super_admin','management') then null else branch end) then raise exception 'You cannot assign this role or center' using errcode='42501'; end if;
  if target=auth.uid() then raise exception 'Another administrator must change your access' using errcode='42501'; end if;
  if not school_has_role(array['super_admin','management']::app_role[]) and not exists(select 1 from user_memberships where user_id=target and branch_id=branch and is_active) then raise exception 'Use an invitation for a new center member' using errcode='42501'; end if;
  if p_action='revoke' then
   if requested='super_admin' and not exists(select 1 from user_memberships x join profiles p on p.id=x.user_id where x.id<>m.id and x.role='super_admin' and x.is_active and p.is_active and (x.expires_at is null or x.expires_at>now())) then raise exception 'Keep at least one active owner' using errcode='22023'; end if;
   update user_memberships set is_active=false,updated_at=now() where id=m.id;
  else
   expiration:=(p_data->>'expires_at')::timestamptz;
   if expiration is not null and expiration<=now() then raise exception 'Access expiry must be in the future' using errcode='22023'; end if;
   if requested='super_admin' and expiration is not null then raise exception 'Owner access cannot expire automatically' using errcode='22023'; end if;
   if not exists(select 1 from profiles where id=target and is_active) then raise exception 'Choose an active account' using errcode='22023'; end if;
   insert into user_memberships(user_id,branch_id,role,expires_at) values(target,branch,requested,expiration) returning * into m;
  end if;
  result:=jsonb_build_object('id',m.id);
 elsif p_action='status' then
  target:=(p_data->>'user_id')::uuid;
  if not school_has_role(array['super_admin']::app_role[]) or target=auth.uid() then raise exception 'An owner must change another account status' using errcode='42501'; end if;
  if (p_data->>'is_active')::boolean is null then raise exception 'Account status is required' using errcode='22023'; end if;
  if not (p_data->>'is_active')::boolean and exists(select 1 from user_memberships where user_id=target and role='super_admin' and is_active) and not exists(select 1 from user_memberships x join profiles p on p.id=x.user_id where x.user_id<>target and x.role='super_admin' and x.is_active and p.is_active and (x.expires_at is null or x.expires_at>now())) then raise exception 'Keep at least one active owner' using errcode='22023'; end if;
  update profiles set is_active=(p_data->>'is_active')::boolean,updated_at=now() where id=target;
  if not found then raise exception 'Account is unavailable' using errcode='P0002'; end if;
  result:=jsonb_build_object('id',target);
 else raise exception 'Unknown account action' using errcode='22023'; end if;
 insert into audit_events(actor_user_id,branch_id,event_type,entity_type,entity_id,metadata)
 values(auth.uid(),branch,'school.access_'||p_action,'access',(result->>'id')::uuid,p_data-'token');
 return result;
end $$;

create function public.school_accept_invitation(p_token text) returns jsonb
language plpgsql security definer set search_path=public,extensions,pg_temp as $$
declare inv school_invitations; mail text; verified timestamptz; member uuid;
begin
 perform pg_advisory_xact_lock(26102601);
 if auth.uid() is null then raise exception 'Sign in to accept your invitation' using errcode='42501'; end if;
 select email,email_confirmed_at into mail,verified from auth.users where id=auth.uid();
 select * into inv from school_invitations where token_hash=digest(p_token,'sha256') for update;
 if not found or inv.revoked_at is not null or inv.expires_at<=now() or inv.accepted_at is not null or lower(mail)<>inv.email or verified is null then raise exception 'Invitation is invalid, expired, used, or belongs to a different verified email' using errcode='42501'; end if;
 if not exists(select 1 from profiles where id=auth.uid() and is_active) then raise exception 'Account is inactive' using errcode='42501'; end if;
 if inv.branch_id is not null and not exists(select 1 from branches where id=inv.branch_id and is_active) then raise exception 'Center is inactive' using errcode='42501'; end if;
 if inv.membership_expires_at is not null and inv.membership_expires_at<=now() then raise exception 'Assigned access has expired' using errcode='42501'; end if;
 -- An invitation cannot survive removal of the creator's authority.
 if not exists(select 1 from profiles p join user_memberships m on m.user_id=p.id where p.id=inv.created_by and p.is_active and m.is_active and (m.expires_at is null or m.expires_at>now()) and
 (m.role='super_admin' or (inv.role not in ('super_admin','management') and (m.role='management' or (m.role='branch_admin' and m.branch_id=inv.branch_id and inv.role in ('teacher','parent','accountant','admission_counsellor')))))) then raise exception 'Invitation issuer no longer has authority' using errcode='42501'; end if;
 select id into member from user_memberships where user_id=auth.uid() and role=inv.role and branch_id is not distinct from inv.branch_id and is_active;
 if member is not null then raise exception 'This role is already assigned; ask an administrator to review access' using errcode='22023'; end if;
 insert into user_memberships(user_id,branch_id,role,expires_at) values(auth.uid(),inv.branch_id,inv.role,inv.membership_expires_at) returning id into member;
 update profiles set full_name=inv.full_name where id=auth.uid();
 update school_invitations set accepted_by=auth.uid(),accepted_at=now() where id=inv.id;
 insert into audit_events(actor_user_id,branch_id,event_type,entity_type,entity_id) values(auth.uid(),inv.branch_id,'school.invitation_accepted','membership',member);
 return jsonb_build_object('id',member);
end $$;

create function public.school_access_directory() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object(
 'memberships',coalesce((select jsonb_agg(to_jsonb(m) order by m.created_at desc) from user_memberships m where school_can_manage(m.branch_id)), '[]'::jsonb),
 'users',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'full_name',p.full_name,'is_active',p.is_active,'email',u.email) order by p.full_name) from profiles p join auth.users u on u.id=p.id where exists(select 1 from user_memberships m where m.user_id=p.id and school_can_manage(m.branch_id))),'[]'::jsonb),
 'invitations',coalesce((select jsonb_agg(to_jsonb(i)-'token_hash' order by i.created_at desc) from school_invitations i where school_can_manage(i.branch_id)),'[]'::jsonb),
 'audit',coalesce((select jsonb_agg(to_jsonb(a)) from (select id,actor_user_id,event_type,entity_type,entity_id,occurred_at,branch_id from audit_events where event_type like 'school.%' and school_can_manage(branch_id) order by occurred_at desc limit 100) a),'[]'::jsonb))
$$;

create function public.school_readiness() returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object('schema_version','202610260001','ready',
  coalesce((inventory_readiness()->>'ready')::boolean,false)
  and to_regprocedure('public.school_save_record(text,jsonb,uuid,integer)') is not null
  and to_regprocedure('public.school_accept_invitation(text)') is not null
  and exists(select 1 from pg_attribute where attrelid='public.user_memberships'::regclass and attname='expires_at' and not attisdropped))
$$;
revoke all on function school_readiness() from public;
grant execute on function school_readiness() to anon,authenticated;

-- Explicit grants protect against Supabase default function privileges.
revoke all on function school_record_guard() from public,anon,authenticated;
do $$ declare sig text; begin
 foreach sig in array array['school_has_role(public.app_role[],uuid)','school_can_read(uuid)','school_can_manage(uuid)','school_may_grant(public.app_role,uuid)','school_save_record(text,jsonb,uuid,integer)','school_access_command(text,jsonb)','school_accept_invitation(text)','school_access_directory()'] loop
  execute 'revoke all on function public.'||sig||' from public,anon';
  execute 'grant execute on function public.'||sig||' to authenticated';
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
