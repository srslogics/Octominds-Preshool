-- First-class center onboarding for the standalone multi-center inventory module.
-- Apply after 202608290001_inventory_production.sql.

create or replace function public.create_inventory_center(
  p_name text,
  p_code text,
  p_address text default null,
  p_phone text default null,
  p_timezone text default 'Asia/Kolkata'
)
returns table (
  id uuid,
  name text,
  code text,
  address text,
  phone text,
  timezone text,
  is_active boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_center public.branches%rowtype;
begin
  if not exists (
    select 1
    from public.user_memberships membership
    join public.profiles profile on profile.id = membership.user_id
    where membership.user_id = auth.uid()
      and membership.is_active
      and profile.is_active
      and membership.role in ('super_admin', 'management')
  ) then
    raise exception 'inventory_access_denied' using errcode = '42501';
  end if;

  insert into public.branches (name, code, address, phone, timezone)
  values (
    trim(p_name),
    upper(trim(p_code)),
    nullif(trim(p_address), ''),
    nullif(trim(p_phone), ''),
    coalesce(nullif(trim(p_timezone), ''), 'Asia/Kolkata')
  )
  returning * into v_center;

  insert into public.audit_events (
    actor_user_id,
    branch_id,
    event_type,
    entity_type,
    entity_id,
    metadata
  ) values (
    auth.uid(),
    v_center.id,
    'inventory.center_created',
    'branch',
    v_center.id,
    jsonb_build_object('name', v_center.name, 'code', v_center.code)
  );

  return query
  select
    v_center.id,
    v_center.name,
    v_center.code,
    v_center.address,
    v_center.phone,
    v_center.timezone,
    v_center.is_active;
end;
$$;

revoke all on function public.create_inventory_center(text, text, text, text, text) from public, anon;
grant execute on function public.create_inventory_center(text, text, text, text, text) to authenticated;

-- Supabase may provision explicit RPC grants for API roles. Inventory commands
-- must never be callable by an anonymous browser session.
revoke all on function public.has_inventory_access(uuid, boolean) from anon;
revoke all on function public.post_inventory_movement(uuid, uuid, uuid, public.inventory_movement_type, numeric, numeric, text, text, text) from anon;
revoke all on function public.transfer_inventory_stock(uuid, uuid, uuid, uuid, numeric, text, text, text) from anon;

comment on function public.create_inventory_center(text, text, text, text, text)
  is 'Creates an inventory center for an active Super Admin or Management user.';

notify pgrst, 'reload schema';
