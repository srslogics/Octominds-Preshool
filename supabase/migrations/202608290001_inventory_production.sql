-- OctoMinds production inventory foundation.
-- Apply after 202608160001_phase_1_foundation.sql.

create type public.inventory_movement_type as enum (
  'opening_balance',
  'receipt',
  'issue',
  'return_in',
  'transfer_out',
  'transfer_in',
  'adjustment_gain',
  'adjustment_loss'
);

create table public.inventory_categories (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  name text not null,
  code text not null,
  description text,
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_categories_name_present check (length(trim(name)) between 2 and 80),
  constraint inventory_categories_code_format check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  unique (branch_id, code),
  unique (id, branch_id)
);

create table public.inventory_locations (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  name text not null,
  code text not null,
  location_type text not null default 'branch_store',
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_locations_name_present check (length(trim(name)) between 2 and 80),
  constraint inventory_locations_code_format check (code ~ '^[A-Z0-9][A-Z0-9_-]{1,19}$'),
  constraint inventory_locations_type_allowed check (location_type in ('central_store', 'branch_store', 'classroom', 'daycare', 'office')),
  unique (branch_id, code),
  unique (id, branch_id)
);

create table public.inventory_items (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  category_id uuid not null,
  name text not null,
  sku text not null,
  description text,
  unit text not null default 'piece',
  reorder_level numeric(14,3) not null default 0,
  standard_cost numeric(14,2),
  is_active boolean not null default true,
  created_by uuid not null references public.profiles(id) on delete restrict default auth.uid(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint inventory_items_name_present check (length(trim(name)) between 2 and 120),
  constraint inventory_items_sku_format check (sku ~ '^[A-Z0-9][A-Z0-9._/-]{1,39}$'),
  constraint inventory_items_unit_allowed check (unit in ('piece', 'packet', 'box', 'set', 'litre', 'kilogram', 'metre', 'roll')),
  constraint inventory_items_reorder_nonnegative check (reorder_level >= 0),
  constraint inventory_items_cost_nonnegative check (standard_cost is null or standard_cost >= 0),
  unique (branch_id, sku),
  unique (id, branch_id),
  constraint inventory_item_category_branch_fk foreign key (category_id, branch_id)
    references public.inventory_categories(id, branch_id) on delete restrict
);

create table public.inventory_stock_balances (
  branch_id uuid not null references public.branches(id) on delete restrict,
  location_id uuid not null,
  item_id uuid not null,
  quantity_on_hand numeric(14,3) not null default 0,
  average_unit_cost numeric(14,2),
  version bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (location_id, item_id),
  constraint inventory_stock_nonnegative check (quantity_on_hand >= 0),
  constraint inventory_average_cost_nonnegative check (average_unit_cost is null or average_unit_cost >= 0),
  constraint inventory_balance_location_branch_fk foreign key (location_id, branch_id)
    references public.inventory_locations(id, branch_id) on delete restrict,
  constraint inventory_balance_item_branch_fk foreign key (item_id, branch_id)
    references public.inventory_items(id, branch_id) on delete restrict
);

create table public.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.branches(id) on delete restrict,
  item_id uuid not null,
  location_id uuid not null,
  movement_type public.inventory_movement_type not null,
  quantity numeric(14,3) not null,
  signed_quantity numeric(14,3) not null,
  quantity_before numeric(14,3) not null,
  quantity_after numeric(14,3) not null,
  unit_cost numeric(14,2),
  reference text,
  notes text,
  transfer_group_id uuid,
  idempotency_key text,
  posted_by uuid not null references public.profiles(id) on delete restrict default auth.uid(),
  posted_at timestamptz not null default now(),
  constraint inventory_movement_quantity_positive check (quantity > 0),
  constraint inventory_movement_result_nonnegative check (quantity_after >= 0),
  constraint inventory_movement_cost_nonnegative check (unit_cost is null or unit_cost >= 0),
  constraint inventory_movement_reference_length check (reference is null or length(reference) <= 80),
  constraint inventory_movement_notes_length check (notes is null or length(notes) <= 500),
  constraint inventory_movement_item_branch_fk foreign key (item_id, branch_id)
    references public.inventory_items(id, branch_id) on delete restrict,
  constraint inventory_movement_location_branch_fk foreign key (location_id, branch_id)
    references public.inventory_locations(id, branch_id) on delete restrict
);

create unique index inventory_movement_idempotency_unique
  on public.inventory_movements (posted_by, idempotency_key)
  where idempotency_key is not null;
create index inventory_items_branch_name_idx on public.inventory_items(branch_id, is_active, name);
create index inventory_balances_branch_item_idx on public.inventory_stock_balances(branch_id, item_id);
create index inventory_movements_branch_posted_idx on public.inventory_movements(branch_id, posted_at desc);

create or replace function public.has_inventory_access(target_branch_id uuid, require_write boolean default false)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.user_memberships membership
    join public.profiles profile on profile.id = membership.user_id
    where membership.user_id = auth.uid()
      and membership.is_active
      and profile.is_active
      and (
        membership.role in ('super_admin', 'management')
        or membership.branch_id = target_branch_id
      )
      and (
        not require_write
        or membership.role in ('super_admin', 'management', 'branch_admin')
      )
  );
$$;

revoke all on function public.has_inventory_access(uuid, boolean) from public;
grant execute on function public.has_inventory_access(uuid, boolean) to authenticated;

create or replace function public.post_inventory_movement(
  p_branch_id uuid,
  p_item_id uuid,
  p_location_id uuid,
  p_movement_type public.inventory_movement_type,
  p_quantity numeric,
  p_unit_cost numeric default null,
  p_reference text default null,
  p_notes text default null,
  p_idempotency_key text default null
)
returns table (movement_id uuid, quantity_after numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_before numeric(14,3);
  v_after numeric(14,3);
  v_delta numeric(14,3);
  v_current_cost numeric(14,2);
  v_new_cost numeric(14,2);
  v_existing public.inventory_movements%rowtype;
  v_movement_id uuid;
begin
  if auth.uid() is null or not public.has_inventory_access(p_branch_id, true) then
    raise exception 'inventory_access_denied' using errcode = '42501';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999.999 then
    raise exception 'invalid_inventory_quantity' using errcode = '22023';
  end if;
  if p_unit_cost is not null and p_unit_cost < 0 then
    raise exception 'invalid_inventory_cost' using errcode = '22023';
  end if;
  if p_movement_type in ('transfer_out', 'transfer_in') then
    raise exception 'use_inventory_transfer_command' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    select * into v_existing from public.inventory_movements
      where posted_by = auth.uid() and idempotency_key = p_idempotency_key;
    if found then
      return query select v_existing.id, v_existing.quantity_after;
      return;
    end if;
  end if;
  if not exists (
    select 1 from public.inventory_items item
    where item.id = p_item_id and item.branch_id = p_branch_id and item.is_active
  ) then raise exception 'inventory_item_not_found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from public.inventory_locations location
    where location.id = p_location_id and location.branch_id = p_branch_id and location.is_active
  ) then raise exception 'inventory_location_not_found' using errcode = 'P0002'; end if;

  insert into public.inventory_stock_balances (branch_id, location_id, item_id)
  values (p_branch_id, p_location_id, p_item_id)
  on conflict (location_id, item_id) do nothing;

  select balance.quantity_on_hand, balance.average_unit_cost
    into v_before, v_current_cost
    from public.inventory_stock_balances balance
    where balance.location_id = p_location_id and balance.item_id = p_item_id
    for update;

  v_delta := case
    when p_movement_type in ('opening_balance', 'receipt', 'return_in', 'adjustment_gain') then p_quantity
    else -p_quantity
  end;
  v_after := v_before + v_delta;
  if p_movement_type = 'opening_balance' and v_before <> 0 then
    raise exception 'opening_balance_already_exists' using errcode = '23514';
  end if;
  if v_after < 0 then raise exception 'insufficient_stock' using errcode = '23514'; end if;

  v_new_cost := v_current_cost;
  if v_delta > 0 and p_unit_cost is not null then
    v_new_cost := case when v_after = 0 then p_unit_cost
      else round(((v_before * coalesce(v_current_cost, p_unit_cost)) + (p_quantity * p_unit_cost)) / v_after, 2)
    end;
  end if;

  begin
    insert into public.inventory_movements (
      branch_id, item_id, location_id, movement_type, quantity, signed_quantity,
      quantity_before, quantity_after, unit_cost, reference, notes, idempotency_key, posted_by
    ) values (
      p_branch_id, p_item_id, p_location_id, p_movement_type, p_quantity, v_delta,
      v_before, v_after, p_unit_cost, nullif(trim(p_reference), ''), nullif(trim(p_notes), ''),
      nullif(trim(p_idempotency_key), ''), auth.uid()
    ) returning id into v_movement_id;
  exception when unique_violation then
    if p_idempotency_key is null then raise; end if;
    select * into v_existing from public.inventory_movements
      where posted_by = auth.uid() and idempotency_key = p_idempotency_key;
    if not found then raise; end if;
    return query select v_existing.id, v_existing.quantity_after;
    return;
  end;

  update public.inventory_stock_balances
    set quantity_on_hand = v_after,
        average_unit_cost = v_new_cost,
        version = version + 1,
        updated_at = now()
    where location_id = p_location_id and item_id = p_item_id;

  insert into public.audit_events (actor_user_id, branch_id, event_type, entity_type, entity_id, metadata)
  values (auth.uid(), p_branch_id, 'inventory.movement_posted', 'inventory_movement', v_movement_id,
    jsonb_build_object('item_id', p_item_id, 'location_id', p_location_id, 'movement_type', p_movement_type, 'quantity', p_quantity));

  return query select v_movement_id, v_after;
end;
$$;

revoke all on function public.post_inventory_movement(uuid, uuid, uuid, public.inventory_movement_type, numeric, numeric, text, text, text) from public;
grant execute on function public.post_inventory_movement(uuid, uuid, uuid, public.inventory_movement_type, numeric, numeric, text, text, text) to authenticated;

create or replace function public.transfer_inventory_stock(
  p_branch_id uuid,
  p_item_id uuid,
  p_from_location_id uuid,
  p_to_location_id uuid,
  p_quantity numeric,
  p_reference text default null,
  p_notes text default null,
  p_idempotency_key text default null
)
returns table (transfer_group_id uuid, from_quantity_after numeric, to_quantity_after numeric)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_group_id uuid;
  v_from_before numeric(14,3);
  v_to_before numeric(14,3);
  v_from_after numeric(14,3);
  v_to_after numeric(14,3);
  v_source_cost numeric(14,2);
  v_destination_cost numeric(14,2);
  v_new_destination_cost numeric(14,2);
begin
  if auth.uid() is null or not public.has_inventory_access(p_branch_id, true) then
    raise exception 'inventory_access_denied' using errcode = '42501';
  end if;
  if p_from_location_id = p_to_location_id then
    raise exception 'inventory_transfer_same_location' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999.999 then
    raise exception 'invalid_inventory_quantity' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    select movement.transfer_group_id, movement.quantity_after
      into v_group_id, v_from_after
      from public.inventory_movements movement
      where movement.posted_by = auth.uid() and movement.idempotency_key = p_idempotency_key || ':out';
    if found then
      select movement.quantity_after into v_to_after
        from public.inventory_movements movement
        where movement.transfer_group_id = v_group_id and movement.movement_type = 'transfer_in';
      return query select v_group_id, v_from_after, v_to_after;
      return;
    end if;
  end if;
  if not exists (
    select 1 from public.inventory_items item
    where item.id = p_item_id and item.branch_id = p_branch_id and item.is_active
  ) then raise exception 'inventory_item_not_found' using errcode = 'P0002'; end if;
  if (
    select count(*) from public.inventory_locations location
    where location.id in (p_from_location_id, p_to_location_id)
      and location.branch_id = p_branch_id and location.is_active
  ) <> 2 then raise exception 'inventory_location_not_found' using errcode = 'P0002'; end if;

  insert into public.inventory_stock_balances (branch_id, location_id, item_id)
  values (p_branch_id, p_from_location_id, p_item_id), (p_branch_id, p_to_location_id, p_item_id)
  on conflict (location_id, item_id) do nothing;

  perform 1 from public.inventory_stock_balances balance
    where balance.item_id = p_item_id
      and balance.location_id in (p_from_location_id, p_to_location_id)
    order by balance.location_id
    for update;

  if p_idempotency_key is not null then
    select movement.transfer_group_id, movement.quantity_after
      into v_group_id, v_from_after
      from public.inventory_movements movement
      where movement.posted_by = auth.uid() and movement.idempotency_key = p_idempotency_key || ':out';
    if found then
      select movement.quantity_after into v_to_after
        from public.inventory_movements movement
        where movement.transfer_group_id = v_group_id and movement.movement_type = 'transfer_in';
      return query select v_group_id, v_from_after, v_to_after;
      return;
    end if;
  end if;

  select balance.quantity_on_hand, balance.average_unit_cost
    into v_from_before, v_source_cost
    from public.inventory_stock_balances balance
    where balance.location_id = p_from_location_id and balance.item_id = p_item_id;
  select balance.quantity_on_hand, balance.average_unit_cost
    into v_to_before, v_destination_cost
    from public.inventory_stock_balances balance
    where balance.location_id = p_to_location_id and balance.item_id = p_item_id;

  if v_from_before < p_quantity then
    raise exception 'insufficient_stock' using errcode = '23514';
  end if;
  v_from_after := v_from_before - p_quantity;
  v_to_after := v_to_before + p_quantity;
  v_new_destination_cost := case
    when v_to_after = 0 then v_source_cost
    when v_source_cost is null then v_destination_cost
    else round(((v_to_before * coalesce(v_destination_cost, v_source_cost)) + (p_quantity * v_source_cost)) / v_to_after, 2)
  end;
  v_group_id := gen_random_uuid();

  insert into public.inventory_movements (
    branch_id, item_id, location_id, movement_type, quantity, signed_quantity,
    quantity_before, quantity_after, unit_cost, reference, notes, transfer_group_id,
    idempotency_key, posted_by
  ) values
    (p_branch_id, p_item_id, p_from_location_id, 'transfer_out', p_quantity, -p_quantity,
      v_from_before, v_from_after, v_source_cost, nullif(trim(p_reference), ''), nullif(trim(p_notes), ''),
      v_group_id, case when p_idempotency_key is null then null else p_idempotency_key || ':out' end, auth.uid()),
    (p_branch_id, p_item_id, p_to_location_id, 'transfer_in', p_quantity, p_quantity,
      v_to_before, v_to_after, v_source_cost, nullif(trim(p_reference), ''), nullif(trim(p_notes), ''),
      v_group_id, case when p_idempotency_key is null then null else p_idempotency_key || ':in' end, auth.uid());

  update public.inventory_stock_balances
    set quantity_on_hand = v_from_after, version = version + 1, updated_at = now()
    where location_id = p_from_location_id and item_id = p_item_id;
  update public.inventory_stock_balances
    set quantity_on_hand = v_to_after, average_unit_cost = v_new_destination_cost,
        version = version + 1, updated_at = now()
    where location_id = p_to_location_id and item_id = p_item_id;

  insert into public.audit_events (actor_user_id, branch_id, event_type, entity_type, entity_id, metadata)
  values (auth.uid(), p_branch_id, 'inventory.stock_transferred', 'inventory_transfer', v_group_id,
    jsonb_build_object('item_id', p_item_id, 'from_location_id', p_from_location_id,
      'to_location_id', p_to_location_id, 'quantity', p_quantity));

  return query select v_group_id, v_from_after, v_to_after;
end;
$$;

revoke all on function public.transfer_inventory_stock(uuid, uuid, uuid, uuid, numeric, text, text, text) from public;
grant execute on function public.transfer_inventory_stock(uuid, uuid, uuid, uuid, numeric, text, text, text) to authenticated;

create or replace function public.prevent_inventory_movement_mutation()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  raise exception 'inventory_movements_are_immutable' using errcode = '55000';
end;
$$;

create trigger inventory_movements_immutable
  before update or delete on public.inventory_movements
  for each row execute function public.prevent_inventory_movement_mutation();

alter table public.inventory_categories enable row level security;
alter table public.inventory_locations enable row level security;
alter table public.inventory_items enable row level security;
alter table public.inventory_stock_balances enable row level security;
alter table public.inventory_movements enable row level security;

create policy inventory_categories_read on public.inventory_categories for select to authenticated using (public.has_inventory_access(branch_id, false));
create policy inventory_categories_write on public.inventory_categories for insert to authenticated with check (public.has_inventory_access(branch_id, true) and created_by = auth.uid());
create policy inventory_categories_update on public.inventory_categories for update to authenticated using (public.has_inventory_access(branch_id, true)) with check (public.has_inventory_access(branch_id, true));
create policy inventory_locations_read on public.inventory_locations for select to authenticated using (public.has_inventory_access(branch_id, false));
create policy inventory_locations_write on public.inventory_locations for insert to authenticated with check (public.has_inventory_access(branch_id, true) and created_by = auth.uid());
create policy inventory_locations_update on public.inventory_locations for update to authenticated using (public.has_inventory_access(branch_id, true)) with check (public.has_inventory_access(branch_id, true));
create policy inventory_items_read on public.inventory_items for select to authenticated using (public.has_inventory_access(branch_id, false));
create policy inventory_items_write on public.inventory_items for insert to authenticated with check (public.has_inventory_access(branch_id, true) and created_by = auth.uid());
create policy inventory_items_update on public.inventory_items for update to authenticated using (public.has_inventory_access(branch_id, true)) with check (public.has_inventory_access(branch_id, true));
create policy inventory_balances_read on public.inventory_stock_balances for select to authenticated using (public.has_inventory_access(branch_id, false));
create policy inventory_movements_read on public.inventory_movements for select to authenticated using (public.has_inventory_access(branch_id, false));

revoke all on public.inventory_categories, public.inventory_locations, public.inventory_items, public.inventory_stock_balances, public.inventory_movements from anon;
grant select, insert, update on public.inventory_categories, public.inventory_locations, public.inventory_items to authenticated;
grant select on public.inventory_stock_balances, public.inventory_movements to authenticated;

comment on table public.inventory_movements is 'Immutable inventory ledger. Posted rows must never be updated or deleted.';
