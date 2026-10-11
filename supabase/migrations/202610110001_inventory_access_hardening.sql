-- Apply after all earlier migrations. Never grant clients control of account status.
begin;

revoke update on public.profiles from authenticated, anon;
grant update (full_name, phone, avatar_path) on public.profiles to authenticated;

-- Audit records are written by the trusted, security-definer inventory commands.
drop policy if exists audit_events_insert_authenticated on public.audit_events;
revoke insert, update, delete on public.audit_events from authenticated, anon;

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
    join public.branches branch on branch.id = target_branch_id and branch.is_active
    where membership.user_id = auth.uid()
      and membership.is_active
      and profile.is_active
      and membership.role in ('super_admin', 'management', 'branch_admin', 'accountant')
      and (membership.role in ('super_admin', 'management') or membership.branch_id = target_branch_id)
      and (not require_write or membership.role in ('super_admin', 'management', 'branch_admin'))
  );
$$;

revoke all on function public.has_inventory_access(uuid, boolean) from public;
grant execute on function public.has_inventory_access(uuid, boolean) to authenticated;

commit;
