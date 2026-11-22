-- Parent portal v1. No existing student or stock data is changed.
begin;
create table public.parent_students (
 id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id),
 class_id uuid not null, full_name text not null check(length(trim(full_name)) between 1 and 120),
 is_active boolean not null default true, version integer not null default 1,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
 foreign key(class_id,branch_id) references school_classes(id,branch_id)
);
create table public.parent_guardians (
 id uuid primary key default gen_random_uuid(), student_id uuid not null references parent_students(id),
 user_id uuid not null references profiles(id), relationship text not null check(length(trim(relationship)) between 1 and 40),
 is_active boolean not null default true, unique(student_id,user_id)
);
create table public.parent_posts (
 id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id),
 class_id uuid not null, student_id uuid references parent_students(id),
 kind text not null check(kind in ('notice','homework','diary','event')),
 title text not null check(length(trim(title)) between 1 and 160),
 body text not null check(length(trim(body)) between 1 and 10000), event_date date,
 is_published boolean not null default true, created_by uuid not null references profiles(id),
 created_at timestamptz not null default now(),
 check((kind='event')=(event_date is not null)),
 foreign key(class_id,branch_id) references school_classes(id,branch_id)
);
create table public.parent_messages (
 id uuid primary key default gen_random_uuid(), student_id uuid not null references parent_students(id),
 author_id uuid not null references profiles(id), body text not null check(length(trim(body)) between 1 and 2000),
 created_at timestamptz not null default now()
);
create index on parent_students(branch_id,class_id);
create index on parent_guardians(user_id,student_id) where is_active;
create index on parent_posts(class_id,created_at desc,id desc) where is_published;
create index on parent_messages(student_id,created_at desc,id desc);

create function public.parents_can_teach(p_class uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from school_classes c join academic_years y on y.id=c.academic_year_id
 join branches b on b.id=c.branch_id where c.id=p_class and c.is_active and b.is_active and y.status<>'closed'
 and (school_can_manage(c.branch_id) or
 (school_has_role(array['teacher']::app_role[],c.branch_id) and exists(
 select 1 from teacher_assignments a where a.class_id=c.id and a.user_id=auth.uid() and a.is_active
 and a.starts_on<=current_date and (a.ends_on is null or a.ends_on>=current_date)))))
$$;
create function public.parents_can_read_child(p_student uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from parent_students s join branches b on b.id=s.branch_id where s.id=p_student and b.is_active
 and (school_can_manage(s.branch_id) or (s.is_active and (parents_can_teach(s.class_id) or
 (school_has_role(array['parent']::app_role[],s.branch_id) and exists(
 select 1 from parent_guardians g where g.student_id=s.id and g.user_id=auth.uid() and g.is_active))))))
$$;
create function public.parents_can_read_post(p_post uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from parent_posts p where p.id=p_post and p.is_published and exists(
 select 1 from parent_students s where s.class_id=p.class_id and s.is_active
 and (p.student_id is null or p.student_id=s.id) and parents_can_read_child(s.id)))
$$;

do $$ declare t text; begin
 foreach t in array array['parent_students','parent_guardians','parent_posts','parent_messages'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
  execute format('grant select on public.%I to authenticated',t);
 end loop;
end $$;
create policy child_read on parent_students for select to authenticated using(parents_can_read_child(id));
-- Parents do not get a directory of other guardians, even for a shared child.
create policy guardian_read on parent_guardians for select to authenticated using(
 (user_id=auth.uid() and parents_can_read_child(student_id)) or
 exists(select 1 from parent_students s where s.id=student_id and school_can_manage(s.branch_id)));
create policy post_read on parent_posts for select to authenticated using(parents_can_read_post(id));
create policy message_read on parent_messages for select to authenticated using(parents_can_read_child(student_id));

create function public.parents_workspace() returns jsonb
language sql stable security definer set search_path=public,pg_temp as $$
 select jsonb_build_object(
 'students',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'branch_id',s.branch_id,'class_id',s.class_id,
 'full_name',s.full_name,'is_active',s.is_active,'version',s.version,'center_name',b.name,
 'class_name',trim(c.name||' '||c.section),'year_name',y.name,
 'can_manage',school_can_manage(s.branch_id),'can_publish',parents_can_teach(s.class_id),
 'relationship',(select g.relationship from parent_guardians g where g.student_id=s.id and g.user_id=auth.uid() and g.is_active))
 order by s.full_name,s.id) from parent_students s join branches b on b.id=s.branch_id
 join school_classes c on c.id=s.class_id join academic_years y on y.id=c.academic_year_id
 where parents_can_read_child(s.id)),'[]'::jsonb),
 'classes',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'branch_id',c.branch_id,'name',trim(c.name||' '||c.section),
 'center_name',b.name,'year_name',y.name,'can_manage',school_can_manage(c.branch_id)) order by b.name,c.name,c.section)
 from school_classes c join branches b on b.id=c.branch_id join academic_years y on y.id=c.academic_year_id
 where parents_can_teach(c.id)),'[]'::jsonb),
 'guardians',coalesce((select jsonb_agg(to_jsonb(g)) from parent_guardians g join parent_students s on s.id=g.student_id
 where school_can_manage(s.branch_id)),'[]'::jsonb),
 'parent_accounts',coalesce((select jsonb_agg(jsonb_build_object('user_id',p.id,'branch_id',m.branch_id,'full_name',p.full_name,'email',u.email)
 order by p.full_name) from profiles p join auth.users u on u.id=p.id join user_memberships m on m.user_id=p.id
 where u.email_confirmed_at is not null and p.is_active and m.is_active and m.role='parent' and (m.expires_at is null or m.expires_at>now())
 and school_can_manage(m.branch_id)),'[]'::jsonb))
$$;

create function public.parents_save_student(p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare s parent_students; c school_classes; result parent_students; ident uuid:=(p_data->>'id')::uuid; branch uuid:=(p_data->>'branch_id')::uuid;
begin
 if not school_can_manage(branch) then raise exception 'Center administration access required' using errcode='42501'; end if;
 select * into c from school_classes where id=(p_data->>'class_id')::uuid and branch_id=branch;
 if not found or not c.is_active or exists(select 1 from academic_years where id=c.academic_year_id and status='closed') then
 raise exception 'Choose an active class in an open year at this center' using errcode='22023'; end if;
 if ident is null then
  insert into parent_students(branch_id,class_id,full_name,is_active)
  values(branch,c.id,trim(p_data->>'full_name'),coalesce((p_data->>'is_active')::boolean,true)) returning * into result;
 else
  select * into s from parent_students where id=ident for update;
  if not found then raise exception 'Child is unavailable' using errcode='P0002'; end if;
  if s.branch_id<>branch or s.class_id<>c.id then raise exception 'Class transfers require a separate enrollment workflow' using errcode='22023'; end if;
  if (p_data->>'version')::integer is distinct from s.version then raise exception 'This record changed' using errcode='40001'; end if;
  update parent_students set full_name=trim(p_data->>'full_name'),is_active=coalesce((p_data->>'is_active')::boolean,true),
  version=version+1,updated_at=now() where id=s.id returning * into result;
 end if;
 insert into audit_events(actor_user_id,branch_id,event_type,entity_type,entity_id)
 values(auth.uid(),branch,'parents.student_saved','student',result.id);
 return to_jsonb(result);
end $$;

create function public.parents_link_guardian(p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare s parent_students; result parent_guardians; uid uuid:=(p_data->>'user_id')::uuid; active boolean:=coalesce((p_data->>'is_active')::boolean,true);
begin
 select * into s from parent_students where id=(p_data->>'student_id')::uuid for update;
 if not found or not school_can_manage(s.branch_id) then raise exception 'Center administration access required' using errcode='42501'; end if;
 if active and (not s.is_active or not exists(select 1 from profiles p join auth.users u on u.id=p.id join user_memberships m on m.user_id=p.id
 where u.email_confirmed_at is not null and p.id=uid and p.is_active and m.role='parent' and m.branch_id=s.branch_id and m.is_active
 and (m.expires_at is null or m.expires_at>now()))) then
 raise exception 'Choose an active parent account in this center' using errcode='22023'; end if;
 insert into parent_guardians(student_id,user_id,relationship,is_active)
 values(s.id,uid,trim(p_data->>'relationship'),active)
 on conflict(student_id,user_id) do update set relationship=excluded.relationship,is_active=excluded.is_active returning * into result;
 insert into audit_events(actor_user_id,branch_id,event_type,entity_type,entity_id)
 values(auth.uid(),s.branch_id,'parents.guardian_linked','guardian',result.id);
 return to_jsonb(result);
end $$;

create function public.parents_publish(p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c school_classes; result parent_posts; student uuid:=(p_data->>'student_id')::uuid;
begin
 select * into c from school_classes where id=(p_data->>'class_id')::uuid;
 if not found or not parents_can_teach(c.id) then raise exception 'Assigned teacher or center administration access required' using errcode='42501'; end if;
 if student is not null and not exists(select 1 from parent_students where id=student and class_id=c.id and is_active) then
 raise exception 'Choose a child in this class' using errcode='22023'; end if;
 insert into parent_posts(branch_id,class_id,student_id,kind,title,body,event_date,created_by)
 values(c.branch_id,c.id,student,p_data->>'kind',trim(p_data->>'title'),trim(p_data->>'body'),(p_data->>'event_date')::date,auth.uid()) returning * into result;
 insert into audit_events(actor_user_id,branch_id,event_type,entity_type,entity_id)
 values(auth.uid(),c.branch_id,'parents.post_published','parent_post',result.id);
 return to_jsonb(result);
end $$;

create function public.parents_unpublish(p_post uuid) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare p parent_posts;
begin
 select * into p from parent_posts where id=p_post for update;
 if not found or not parents_can_teach(p.class_id) or (p.created_by<>auth.uid() and not school_can_manage(p.branch_id)) then
 raise exception 'You cannot withdraw this update' using errcode='42501'; end if;
 update parent_posts set is_published=false where id=p.id;
 insert into audit_events(actor_user_id,branch_id,event_type,entity_type,entity_id)
 values(auth.uid(),p.branch_id,'parents.post_withdrawn','parent_post',p.id);
 return jsonb_build_object('id',p.id);
end $$;

create function public.parents_feed(p_student uuid,p_kind text default 'all',p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare s parent_students; result jsonb; total integer;
begin
 if not parents_can_read_child(p_student) then raise exception 'Child access is not assigned' using errcode='42501'; end if;
 if p_page not between 1 and 10000 or p_kind not in ('all','notice','homework','diary','event') then raise exception 'Invalid feed filter' using errcode='22023'; end if;
 select * into s from parent_students where id=p_student;
 select count(*) into total from parent_posts p where p.is_published and p.class_id=s.class_id
 and (p.student_id is null or p.student_id=s.id) and (p_kind='all' or p.kind=p_kind);
 select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at desc,q.id desc),'[]'::jsonb) into result from
 (select p.id,p.kind,p.title,p.body,p.event_date,p.created_at,p.created_by,
 coalesce(pr.full_name,'School team') as author_name,
 (parents_can_teach(p.class_id) and (p.created_by=auth.uid() or school_can_manage(p.branch_id))) as can_withdraw
 from parent_posts p join profiles pr on pr.id=p.created_by where p.is_published and p.class_id=s.class_id
 and (p.student_id is null or p.student_id=s.id) and (p_kind='all' or p.kind=p_kind)
 order by p.created_at desc,p.id desc limit 20 offset (p_page-1)*20) q;
 return jsonb_build_object('posts',result,'total',total,'page',p_page,'page_size',20);
end $$;

create function public.parents_thread(p_student uuid,p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare result jsonb; total integer;
begin
 if not parents_can_read_child(p_student) then raise exception 'Child access is not assigned' using errcode='42501'; end if;
 if p_page not between 1 and 10000 then raise exception 'Invalid page' using errcode='22023'; end if;
 select count(*) into total from parent_messages where student_id=p_student;
 select coalesce(jsonb_agg(to_jsonb(q) order by q.created_at,q.id),'[]'::jsonb) into result from
 (select m.id,m.body,m.created_at,p.full_name as author_name,m.author_id=auth.uid() as is_own
 from parent_messages m join profiles p on p.id=m.author_id where m.student_id=p_student
 order by m.created_at desc,m.id desc limit 30 offset (p_page-1)*30) q;
 return jsonb_build_object('messages',result,'total',total,'page',p_page,'page_size',30);
end $$;

create function public.parents_send_message(p_student uuid,p_body text) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare s parent_students; result parent_messages;
begin
 select * into s from parent_students where id=p_student;
 if not found or not s.is_active or not parents_can_read_child(s.id) then raise exception 'Child access is not assigned' using errcode='42501'; end if;
 insert into parent_messages(student_id,author_id,body) values(s.id,auth.uid(),trim(p_body)) returning * into result;
 return jsonb_build_object('id',result.id);
end $$;

create function public.parents_calendar(p_student uuid,p_month date) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare s parent_students; month_start date:=date_trunc('month',p_month)::date; month_end date:=(date_trunc('month',p_month)+interval '1 month - 1 day')::date;
begin
 if not parents_can_read_child(p_student) then raise exception 'Child access is not assigned' using errcode='42501'; end if;
 if p_month is null then raise exception 'Choose a calendar month' using errcode='22023'; end if;
 select * into s from parent_students where id=p_student;
 return jsonb_build_object('events',coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'title',p.title,'body',p.body,'event_date',p.event_date) order by p.event_date,p.id)
 from parent_posts p where p.is_published and p.kind='event' and p.class_id=s.class_id
 and (p.student_id is null or p.student_id=s.id) and p.event_date between month_start and month_end),'[]'::jsonb),
 'holidays',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'name',h.name,'starts_on',h.starts_on,'ends_on',h.ends_on) order by h.starts_on,h.id)
 from school_holidays h where h.branch_id=s.branch_id and h.is_active and h.starts_on<=month_end and h.ends_on>=month_start),'[]'::jsonb));
end $$;

create function public.parents_readiness() returns jsonb
language sql stable security invoker set search_path=public,pg_temp as $$
 select jsonb_build_object('schema_version','202611210001','ready',
 coalesce((school_readiness()->>'ready')::boolean,false)
 and to_regprocedure('public.parents_feed(uuid,text,integer)') is not null
 and to_regprocedure('public.parents_link_guardian(jsonb)') is not null)
$$;
revoke all on function parents_readiness() from public,anon,authenticated;
grant execute on function parents_readiness() to anon,authenticated;
do $$ declare sig text; begin
 foreach sig in array array['parents_can_teach(uuid)','parents_can_read_child(uuid)','parents_can_read_post(uuid)',
 'parents_workspace()','parents_save_student(jsonb)','parents_link_guardian(jsonb)','parents_publish(jsonb)',
 'parents_calendar(uuid,date)','parents_unpublish(uuid)','parents_feed(uuid,text,integer)','parents_thread(uuid,integer)','parents_send_message(uuid,text)'] loop
 execute 'revoke all on function public.'||sig||' from public,anon,authenticated';
 execute 'grant execute on function public.'||sig||' to authenticated';
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
