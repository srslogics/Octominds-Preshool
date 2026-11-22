-- Private, class/child-scoped albums. Supabase Storage is required.
begin;
create table public.parent_albums (
 id uuid primary key default gen_random_uuid(), branch_id uuid not null references branches(id),
 class_id uuid not null, student_id uuid references parent_students(id),
 title text not null check(length(trim(title)) between 1 and 160),
 description text not null default '' check(length(description)<=2000), taken_on date not null,
 status text not null default 'draft' check(status in ('draft','published','withdrawn')),
 created_by uuid not null references profiles(id), created_at timestamptz not null default now(),
 foreign key(class_id,branch_id) references school_classes(id,branch_id)
);
create table public.parent_photos (
 id uuid primary key, album_id uuid not null references parent_albums(id),
 caption text not null default '' check(length(caption)<=200),
 checksum text not null check(checksum ~ '^[0-9a-f]{64}$'),
 status text not null default 'pending' check(status in ('pending','ready','removed')),
 created_by uuid not null references profiles(id), created_at timestamptz not null default now(),
 width integer, height integer, check(width between 1 and 2048), check(height between 1 and 2048)
);
create index on parent_albums(class_id,taken_on desc,id desc) where status<>'withdrawn';
create index on parent_photos(album_id,created_at,id);

create function public.parents_album_manage(p_album uuid) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from parent_albums a where a.id=p_album and
 (school_can_manage(a.branch_id) or (a.created_by=auth.uid() and parents_can_teach(a.class_id))))
$$;
create function public.parents_album_read(p_album uuid,p_student uuid default null) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from parent_albums a where a.id=p_album and a.status<>'withdrawn' and
 ((p_student is null and parents_album_manage(a.id)) or
 (p_student is not null and exists(select 1 from parent_students s where s.id=p_student
 and s.class_id=a.class_id and (a.student_id is null or a.student_id=s.id) and parents_can_read_child(s.id))
 and (a.status='published' or parents_album_manage(a.id))) or
 (p_student is null and a.status='published' and exists(select 1 from parent_students s
 where s.class_id=a.class_id and (a.student_id is null or a.student_id=s.id) and parents_can_read_child(s.id)))))
$$;
create function public.parents_storage_allowed(p_name text,p_write boolean default false,p_delete boolean default false) returns boolean
language sql stable security definer set search_path=public,pg_temp as $$
 select exists(select 1 from parent_photos p join parent_albums a on a.id=p.album_id
 where p_name in (a.id::text||'/'||p.id::text||'/full.jpg',a.id::text||'/'||p.id::text||'/thumb.jpg')
 and case when p_delete then parents_album_manage(a.id) and (a.status='withdrawn' or p.status='removed')
 when p_write then a.status='draft' and p.status='pending' and p.created_by=auth.uid() and parents_album_manage(a.id)
 else parents_album_manage(a.id) or (p.status='ready' and parents_album_read(a.id)) end)
$$;

alter table parent_albums enable row level security;
alter table parent_photos enable row level security;
revoke all on parent_albums,parent_photos from public,anon,authenticated;
grant select on parent_albums,parent_photos to authenticated;
create policy album_read on parent_albums for select to authenticated using(parents_album_read(id));
create policy photo_read on parent_photos for select to authenticated using(status<>'removed' and parents_album_read(album_id) and (status='ready' or parents_album_manage(album_id)));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('octominds-parent-photos','octominds-parent-photos',false,6291456,array['image/jpeg']) on conflict(id) do nothing;
do $$ begin
 if not exists(select 1 from storage.buckets where id='octominds-parent-photos' and not public
 and file_size_limit=6291456 and allowed_mime_types=array['image/jpeg']) then
 raise exception 'The parent photo bucket must be private, JPEG-only, with a 6 MiB limit'; end if;
end $$;
-- Restrictive policies keep pre-existing broad Storage policies from widening this bucket.
create policy parent_photo_select_guard on storage.objects as restrictive for select to authenticated
 using(bucket_id<>'octominds-parent-photos' or parents_storage_allowed(name));
create policy parent_photo_select on storage.objects for select to authenticated
 using(bucket_id='octominds-parent-photos' and parents_storage_allowed(name));
create policy parent_photo_insert_guard on storage.objects as restrictive for insert to authenticated
 with check(bucket_id<>'octominds-parent-photos' or parents_storage_allowed(name,true));
create policy parent_photo_insert on storage.objects for insert to authenticated
 with check(bucket_id='octominds-parent-photos' and parents_storage_allowed(name,true));
create policy parent_photo_update_guard on storage.objects as restrictive for update to authenticated
 using(bucket_id<>'octominds-parent-photos') with check(bucket_id<>'octominds-parent-photos');
create policy parent_photo_delete_guard on storage.objects as restrictive for delete to authenticated
 using(bucket_id<>'octominds-parent-photos' or parents_storage_allowed(name,false,true));
create policy parent_photo_delete on storage.objects for delete to authenticated
 using(bucket_id='octominds-parent-photos' and parents_storage_allowed(name,false,true));
-- No unauthenticated object access, even if another bucket uses broad anonymous policies.
create policy parent_photo_anon_guard on storage.objects as restrictive for all to anon
 using(bucket_id<>'octominds-parent-photos') with check(bucket_id<>'octominds-parent-photos');

create function public.parents_create_album(p_data jsonb) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare c school_classes; a parent_albums; student uuid:=(p_data->>'student_id')::uuid;
begin
 select * into c from school_classes where id=(p_data->>'class_id')::uuid;
 if not found or not parents_can_teach(c.id) then raise exception 'Assigned teacher or center administration access required' using errcode='42501'; end if;
 if student is not null and not exists(select 1 from parent_students where id=student and class_id=c.id and is_active) then raise exception 'Choose a child in this class' using errcode='22023'; end if;
 insert into parent_albums(branch_id,class_id,student_id,title,description,taken_on,created_by)
 values(c.branch_id,c.id,student,trim(p_data->>'title'),coalesce(p_data->>'description',''),(p_data->>'taken_on')::date,auth.uid()) returning * into a;
 insert into audit_events(actor_user_id,branch_id,event_type,entity_type,entity_id)
 values(auth.uid(),a.branch_id,'parents.album_created','parent_album',a.id);
 return to_jsonb(a);
end $$;

create function public.parents_prepare_photo(p_album uuid,p_photo uuid,p_checksum text,p_caption text default '') returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a parent_albums; p parent_photos;
begin
 select * into a from parent_albums where id=p_album for update;
 if not found or not parents_album_manage(a.id) or a.status<>'draft' then raise exception 'Only the assigned school team can upload to this draft album' using errcode='42501'; end if;
 select * into p from parent_photos where id=p_photo for update;
 if found then
  if p.album_id<>a.id or p.checksum<>p_checksum or p.status='removed' then raise exception 'This upload identifier belongs to different photo content' using errcode='40001'; end if;
 else
  if (select count(*) from parent_photos where album_id=a.id and status<>'removed')>=12 then raise exception 'An album can contain up to 12 photos' using errcode='22023'; end if;
  insert into parent_photos(id,album_id,caption,checksum,created_by) values(p_photo,a.id,trim(p_caption),p_checksum,auth.uid()) returning * into p;
 end if;
 return to_jsonb(p);
end $$;
create function public.parents_finish_photo(p_album uuid,p_photo uuid,p_width integer,p_height integer) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a parent_albums; p parent_photos;
begin
 select * into a from parent_albums where id=p_album for update;
 if not found or not parents_album_manage(a.id) or a.status<>'draft' then raise exception 'Album upload access is unavailable' using errcode='42501'; end if;
 select * into p from parent_photos where id=p_photo and album_id=a.id for update;
 if not found or p.status='removed' then raise exception 'Photo is unavailable' using errcode='P0002'; end if;
 if p_width is null or p_height is null or p_width not between 1 and 2048 or p_height not between 1 and 2048 then raise exception 'Invalid photo dimensions' using errcode='22023'; end if;
 if not exists(select 1 from storage.objects where bucket_id='octominds-parent-photos' and name=a.id::text||'/'||p.id::text||'/full.jpg')
 or not exists(select 1 from storage.objects where bucket_id='octominds-parent-photos' and name=a.id::text||'/'||p.id::text||'/thumb.jpg') then
 raise exception 'Both photo and thumbnail must finish uploading' using errcode='22023'; end if;
 update parent_photos set status='ready',width=p_width,height=p_height where id=p.id returning * into p;
 return to_jsonb(p);
end $$;

create function public.parents_album_command(p_album uuid,p_action text,p_photo uuid default null) returns jsonb
language plpgsql security definer set search_path=public,pg_temp as $$
declare a parent_albums; paths jsonb:='[]'::jsonb;
begin
 select * into a from parent_albums where id=p_album for update;
 if not found or not parents_album_manage(a.id) then raise exception 'Album administration access required' using errcode='42501'; end if;
 if p_action='publish' then
  if a.status='published' then return jsonb_build_object('id',a.id,'paths',paths); end if;
  if a.status<>'draft' or not exists(select 1 from parent_photos where album_id=a.id and status='ready')
  or exists(select 1 from parent_photos where album_id=a.id and status='pending') then raise exception 'Finish or remove incomplete uploads before publishing at least one photo' using errcode='22023'; end if;
  update parent_albums set status='published' where id=a.id;
 elsif p_action in ('withdraw','remove_photo','cleanup') then
  select coalesce(jsonb_agg(path),'[]'::jsonb) into paths from parent_photos p cross join lateral
  (values(a.id::text||'/'||p.id::text||'/full.jpg'),(a.id::text||'/'||p.id::text||'/thumb.jpg')) v(path)
  where p.album_id=a.id and (p_action='withdraw' or (p_action='remove_photo' and p.id=p_photo)
  or (p_action='cleanup' and (a.status='withdrawn' or p.status='removed')));
  if p_action='withdraw' then update parent_albums set status='withdrawn' where id=a.id;
  elsif p_action='remove_photo' then
   update parent_photos set status='removed' where id=p_photo and album_id=a.id;
   if a.status='published' and not exists(select 1 from parent_photos where album_id=a.id and status='ready') then update parent_albums set status='withdrawn' where id=a.id; end if;
  end if;
 else raise exception 'Unknown album action' using errcode='22023'; end if;
 insert into audit_events(actor_user_id,branch_id,event_type,entity_type,entity_id)
 values(auth.uid(),a.branch_id,'parents.album_'||p_action,'parent_album',a.id);
 return jsonb_build_object('id',a.id,'paths',paths);
end $$;

create function public.parents_album_detail(p_album uuid,p_student uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare a parent_albums;
begin
 if not parents_album_read(p_album,p_student) then raise exception 'Album access is not assigned' using errcode='42501'; end if;
 select * into a from parent_albums where id=p_album;
 return (to_jsonb(a)-'created_by')||jsonb_build_object('can_manage',parents_album_manage(a.id),'photos',
 coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'caption',p.caption,'status',p.status,'width',p.width,'height',p.height) order by p.created_at,p.id)
 from parent_photos p where p.album_id=a.id and (p.status='ready' or (p.status='pending' and parents_album_manage(a.id)))),'[]'::jsonb));
end $$;
create function public.parents_gallery(p_student uuid,p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare s parent_students; items jsonb; total integer;
begin
 if not parents_can_read_child(p_student) then raise exception 'Child access is not assigned' using errcode='42501'; end if;
 if p_page not between 1 and 10000 then raise exception 'Invalid gallery page' using errcode='22023'; end if;
 select * into s from parent_students where id=p_student;
 select count(*) into total from parent_albums a where a.class_id=s.class_id and (a.student_id is null or a.student_id=s.id)
 and a.status<>'withdrawn' and (a.status='published' or parents_album_manage(a.id));
 select coalesce(jsonb_agg(parents_album_detail(q.id,p_student) order by q.taken_on desc,q.id desc),'[]'::jsonb) into items from
 (select a.id,a.taken_on from parent_albums a where a.class_id=s.class_id and (a.student_id is null or a.student_id=s.id)
 and a.status<>'withdrawn' and (a.status='published' or parents_album_manage(a.id)) order by a.taken_on desc,a.id desc limit 12 offset (p_page-1)*12) q;
 return jsonb_build_object('albums',items,'total',total,'page',p_page,'page_size',12);
end $$;
create function public.parents_staff_albums(p_page integer default 1) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare items jsonb; total integer;
begin
 if p_page is null or p_page not between 1 and 10000 then raise exception 'Invalid gallery page' using errcode='22023'; end if;
 select count(*) into total from parent_albums a where a.status<>'withdrawn' and parents_album_manage(a.id);
 select coalesce(jsonb_agg(parents_album_detail(q.id) || jsonb_build_object(
 'class_name',q.class_name,'student_name',q.student_name) order by q.taken_on desc,q.id desc),'[]'::jsonb) into items
 from (select a.id,a.taken_on,trim(c.name||' '||c.section) as class_name,s.full_name as student_name
 from parent_albums a join school_classes c on c.id=a.class_id left join parent_students s on s.id=a.student_id
 where a.status<>'withdrawn' and parents_album_manage(a.id)
 order by a.taken_on desc,a.id desc limit 12 offset (p_page-1)*12) q;
 return jsonb_build_object('albums',items,'total',total,'page',p_page,'page_size',12);
end $$;
create function public.parents_photo_access(p_photo uuid,p_student uuid default null) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare p parent_photos;
begin
 select * into p from parent_photos where id=p_photo;
 if not found or p.status<>'ready' or not parents_album_read(p.album_id,p_student) then raise exception 'Photo access is not assigned' using errcode='42501'; end if;
 return jsonb_build_object('path',p.album_id::text||'/'||p.id::text,'caption',p.caption);
end $$;

create function public.parents_photo_cleanup_list() returns jsonb
language sql stable security definer set search_path=public,storage,pg_temp as $$
 select jsonb_build_object('albums',coalesce((select jsonb_agg(to_jsonb(q)) from
 (select a.id,a.title from parent_albums a where parents_album_manage(a.id) and exists(
 select 1 from parent_photos p join storage.objects o on o.bucket_id='octominds-parent-photos'
 and o.name in (a.id::text||'/'||p.id::text||'/full.jpg',a.id::text||'/'||p.id::text||'/thumb.jpg')
 where p.album_id=a.id and (a.status='withdrawn' or p.status='removed')) order by a.created_at,a.id limit 50) q),'[]'::jsonb))
$$;

create function public.parents_gallery_readiness() returns jsonb
language sql stable security definer set search_path=public,storage,pg_temp as $$
 select jsonb_build_object('schema_version','202611210002','ready',coalesce((parents_readiness()->>'ready')::boolean,false)
 and exists(select 1 from storage.buckets where id='octominds-parent-photos' and not public
 and file_size_limit=6291456 and allowed_mime_types=array['image/jpeg'])
 and (select count(*) from pg_policies where schemaname='storage' and tablename='objects' and permissive='RESTRICTIVE'
 and policyname in ('parent_photo_select_guard','parent_photo_insert_guard','parent_photo_update_guard','parent_photo_delete_guard','parent_photo_anon_guard'))=5
 and to_regprocedure('public.parents_gallery(uuid,integer)') is not null)
$$;
revoke all on function parents_gallery_readiness() from public,anon,authenticated;
grant execute on function parents_gallery_readiness() to anon,authenticated;
do $$ declare sig text; begin
 foreach sig in array array['parents_album_manage(uuid)','parents_album_read(uuid,uuid)','parents_storage_allowed(text,boolean,boolean)',
 'parents_create_album(jsonb)','parents_prepare_photo(uuid,uuid,text,text)','parents_finish_photo(uuid,uuid,integer,integer)',
 'parents_staff_albums(integer)','parents_photo_cleanup_list()','parents_album_command(uuid,text,uuid)','parents_album_detail(uuid,uuid)','parents_gallery(uuid,integer)','parents_photo_access(uuid,uuid)'] loop
 execute 'revoke all on function public.'||sig||' from public,anon,authenticated';
 execute 'grant execute on function public.'||sig||' to authenticated';
 end loop;
end $$;
-- Storage's anonymous restrictive policy needs the helper only for authenticated users.
notify pgrst,'reload schema';
commit;
