-- Serialize stock commands and protect catalogue history.
begin;
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
  p_idempotency_key := nullif(trim(p_idempotency_key), '');
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 120 then
    raise exception 'invalid_inventory_idempotency_key' using errcode = '22023';
  end if;
  -- Serialize identical commands before testing balances or opening-history.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_idempotency_key, 0));
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999.999 then
    raise exception 'invalid_inventory_quantity' using errcode = '22023';
  end if;
  if p_unit_cost is not null and (p_unit_cost < 0 or p_unit_cost::text in ('NaN', 'Infinity', '-Infinity')) then
    raise exception 'invalid_inventory_cost' using errcode = '22023';
  end if;
  if p_movement_type in ('transfer_out', 'transfer_in') then
    raise exception 'use_inventory_transfer_command' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    select * into v_existing from public.inventory_movements
      where posted_by = auth.uid() and idempotency_key = p_idempotency_key;
    if found then
      if v_existing.branch_id is distinct from p_branch_id
        or v_existing.item_id is distinct from p_item_id
        or v_existing.location_id is distinct from p_location_id
        or v_existing.movement_type is distinct from p_movement_type
        or v_existing.quantity is distinct from p_quantity
        or v_existing.unit_cost is distinct from p_unit_cost
        or v_existing.reference is distinct from nullif(trim(p_reference), '')
        or v_existing.notes is distinct from nullif(trim(p_notes), '') then
        raise exception 'inventory_idempotency_conflict' using errcode = '22023';
      end if;
      return query select v_existing.id, v_existing.quantity_after;
      return;
    end if;
  end if;
  -- Conflicts with catalogue UPDATE, preventing archive/unit-change races.
  perform 1 from public.inventory_items item
    where item.id = p_item_id and item.branch_id = p_branch_id and item.is_active
    for share;
  if not found then raise exception 'inventory_item_not_found' using errcode = 'P0002'; end if;
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
  if p_movement_type = 'opening_balance' and (v_before <> 0 or exists (
    select 1 from public.inventory_movements movement
    where movement.item_id = p_item_id and movement.location_id = p_location_id
  )) then
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
    if v_existing.branch_id is distinct from p_branch_id
      or v_existing.item_id is distinct from p_item_id
      or v_existing.location_id is distinct from p_location_id
      or v_existing.movement_type is distinct from p_movement_type
      or v_existing.quantity is distinct from p_quantity
      or v_existing.unit_cost is distinct from p_unit_cost
      or v_existing.reference is distinct from nullif(trim(p_reference), '')
      or v_existing.notes is distinct from nullif(trim(p_notes), '') then
      raise exception 'inventory_idempotency_conflict' using errcode = '22023';
    end if;
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
  p_idempotency_key := nullif(trim(p_idempotency_key), '');
  if p_idempotency_key is null or length(p_idempotency_key) not between 8 and 120 then
    raise exception 'invalid_inventory_idempotency_key' using errcode = '22023';
  end if;
  -- Serialize identical commands before testing balances or opening-history.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || p_idempotency_key, 0));
  if p_quantity is null or p_quantity <= 0 or p_quantity > 999999999.999 then
    raise exception 'invalid_inventory_quantity' using errcode = '22023';
  end if;
  if p_idempotency_key is not null then
    select movement.transfer_group_id, movement.quantity_after
      into v_group_id, v_from_after
      from public.inventory_movements movement
      where movement.posted_by = auth.uid() and movement.idempotency_key = p_idempotency_key || ':out';
    if found then
      if not exists (
        select 1 from public.inventory_movements outgoing
        join public.inventory_movements incoming
          on incoming.transfer_group_id = outgoing.transfer_group_id
          and incoming.movement_type = 'transfer_in'
        where outgoing.posted_by = auth.uid()
          and outgoing.idempotency_key = p_idempotency_key || ':out'
          and outgoing.movement_type = 'transfer_out'
          and outgoing.branch_id = p_branch_id and outgoing.item_id = p_item_id
          and outgoing.location_id = p_from_location_id
          and incoming.location_id = p_to_location_id
          and outgoing.quantity = p_quantity
          and outgoing.reference is not distinct from nullif(trim(p_reference), '')
          and outgoing.notes is not distinct from nullif(trim(p_notes), '')
      ) then raise exception 'inventory_idempotency_conflict' using errcode = '22023'; end if;
      select movement.quantity_after into v_to_after
        from public.inventory_movements movement
        where movement.transfer_group_id = v_group_id and movement.movement_type = 'transfer_in';
      return query select v_group_id, v_from_after, v_to_after;
      return;
    end if;
  end if;
  -- Conflicts with catalogue UPDATE, preventing archive/unit-change races.
  perform 1 from public.inventory_items item
    where item.id = p_item_id and item.branch_id = p_branch_id and item.is_active
    for share;
  if not found then raise exception 'inventory_item_not_found' using errcode = 'P0002'; end if;
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
      if not exists (
        select 1 from public.inventory_movements outgoing
        join public.inventory_movements incoming
          on incoming.transfer_group_id = outgoing.transfer_group_id
          and incoming.movement_type = 'transfer_in'
        where outgoing.posted_by = auth.uid()
          and outgoing.idempotency_key = p_idempotency_key || ':out'
          and outgoing.movement_type = 'transfer_out'
          and outgoing.branch_id = p_branch_id and outgoing.item_id = p_item_id
          and outgoing.location_id = p_from_location_id
          and incoming.location_id = p_to_location_id
          and outgoing.quantity = p_quantity
          and outgoing.reference is not distinct from nullif(trim(p_reference), '')
          and outgoing.notes is not distinct from nullif(trim(p_notes), '')
      ) then raise exception 'inventory_idempotency_conflict' using errcode = '22023'; end if;
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


create or replace function public.guard_inventory_item_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.unit is distinct from old.unit and exists (
    select 1 from public.inventory_movements where item_id = old.id
  ) then
    raise exception 'inventory_unit_has_history' using errcode = '23514';
  end if;
  if not new.is_active and exists (
    select 1 from public.inventory_stock_balances where item_id = old.id and quantity_on_hand <> 0
  ) then
    raise exception 'inventory_item_has_stock' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function public.guard_inventory_item_history() from public, anon, authenticated;
create trigger inventory_item_history_guard
  before update of unit, is_active on public.inventory_items
  for each row execute function public.guard_inventory_item_history();

-- NOT VALID avoids rewriting legacy rows; all new/updated rows are checked.
-- Validate existing rows separately before production sign-off.
alter table public.inventory_items add constraint inventory_standard_cost_finite
  check (standard_cost is null or standard_cost::text not in ('NaN', 'Infinity', '-Infinity')) not valid;
alter table public.inventory_stock_balances add constraint inventory_average_cost_finite
  check (average_unit_cost is null or average_unit_cost::text not in ('NaN', 'Infinity', '-Infinity')) not valid;

commit;
