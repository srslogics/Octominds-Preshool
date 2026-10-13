-- Read-only reporting functions: database-side filtering/counts and one statement snapshot.
-- Existing RLS remains authoritative; no SECURITY DEFINER bypass.
begin;

create or replace function public.inventory_read_items(
  p_branch_id uuid default null, p_search text default '', p_stock_status text default 'all',
  p_page integer default 1, p_page_size integer default 25, p_item_id uuid default null
) returns jsonb language plpgsql stable security invoker set search_path = public, pg_temp as $$
declare result jsonb;
begin
  if p_page < 1 or p_page_size not between 1 and 100 or
     p_stock_status not in ('all','low','out','healthy') or length(p_search) > 80 then
    raise exception 'invalid report parameters' using errcode = '22023';
  end if;
  with base as (
    select i.id, i.branch_id, i.category_id, i.name, i.sku, i.description, i.unit,
      i.reorder_level, i.standard_cost, i.is_active, c.name as category_name,
      coalesce(b.quantity,0) as quantity_on_hand,
      case when coalesce(b.quantity,0) <= 0 then 'out'
        when b.quantity <= i.reorder_level then 'low' else 'healthy' end as stock_status,
      coalesce(b.locations,'[]'::jsonb) as location_names,
      coalesce(b.balances,'[]'::jsonb) as balances
    from public.inventory_items i
    left join public.inventory_categories c on c.id = i.category_id
    left join lateral (
      select sum(s.quantity_on_hand) as quantity,
        jsonb_agg(distinct l.name) filter (where l.name is not null) as locations,
        jsonb_agg(jsonb_build_object('location_id',s.location_id,'quantity_on_hand',s.quantity_on_hand,
          'inventory_locations',jsonb_build_object('name',l.name)) order by l.name,s.location_id) as balances
      from public.inventory_stock_balances s
      left join public.inventory_locations l on l.id = s.location_id
      where s.item_id = i.id
    ) b on true
    where i.is_active and (p_branch_id is null or i.branch_id = p_branch_id)
      and (p_item_id is null or i.id = p_item_id)
      and (p_search = '' or strpos(lower(i.name),lower(p_search)) > 0 or strpos(lower(i.sku),lower(p_search)) > 0)
  ), filtered as materialized (
    select * from base where p_stock_status = 'all' or stock_status = p_stock_status
  ), page_rows as (
    select * from filtered order by name,id limit p_page_size offset (p_page::bigint-1)*p_page_size
  )
  select jsonb_build_object('items',coalesce((select jsonb_agg(to_jsonb(r) order by r.name,r.id) from page_rows r),'[]'::jsonb),
    'total',(select count(*) from filtered),'page',p_page,'page_size',p_page_size) into result;
  return result;
end $$;

create or replace function public.inventory_read_dashboard(p_branch_id uuid default null)
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  with stock as (
    select i.id,i.reorder_level,coalesce(sum(s.quantity_on_hand),0) as quantity
    from public.inventory_items i left join public.inventory_stock_balances s on s.item_id=i.id
    where i.is_active and (p_branch_id is null or i.branch_id=p_branch_id)
    group by i.id,i.reorder_level
  ), days as (
    select b.id,
      date_trunc('day',now() at time zone coalesce(t.name,'Asia/Kolkata')) at time zone coalesce(t.name,'Asia/Kolkata') as starts,
      (date_trunc('day',now() at time zone coalesce(t.name,'Asia/Kolkata')) + interval '1 day') at time zone coalesce(t.name,'Asia/Kolkata') as ends
    from public.branches b left join pg_timezone_names t on t.name=b.timezone
    where b.is_active and (p_branch_id is null or b.id=p_branch_id)
  ) select jsonb_build_object('active_items',count(*),
    'low_stock',count(*) filter (where quantity>0 and quantity<=reorder_level),
    'out_of_stock',count(*) filter (where quantity<=0),
    'movements_today',(select count(*) from public.inventory_movements m join days d on d.id=m.branch_id
       where m.posted_at>=d.starts and m.posted_at<d.ends)) from stock;
$$;

revoke all on function public.inventory_read_items(uuid,text,text,integer,integer,uuid) from public, anon;
revoke all on function public.inventory_read_dashboard(uuid) from public, anon;
grant execute on function public.inventory_read_items(uuid,text,text,integer,integer,uuid) to authenticated;
grant execute on function public.inventory_read_dashboard(uuid) to authenticated;

-- Fail deployment if historical costs need explicit reconciliation; never rewrite them.
alter table public.inventory_items validate constraint inventory_standard_cost_finite;
alter table public.inventory_stock_balances validate constraint inventory_average_cost_finite;

create or replace function public.inventory_readiness()
returns jsonb language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object('schema_version','202610130001','ready',
    to_regprocedure('public.inventory_read_items(uuid,text,text,integer,integer,uuid)') is not null
    and to_regprocedure('public.inventory_read_dashboard(uuid)') is not null
    and (select count(*)=2 from pg_constraint where conname in ('inventory_standard_cost_finite','inventory_average_cost_finite')
      and conrelid in ('public.inventory_items'::regclass,'public.inventory_stock_balances'::regclass) and convalidated));
$$;
revoke all on function public.inventory_readiness() from public;
grant execute on function public.inventory_readiness() to anon, authenticated;
notify pgrst, 'reload schema';
commit;
