-- Run this after the owner is created in Supabase Auth using the internal
-- <10-digit-mobile>@auth.octominds.invalid identity and six-digit PIN, with
-- the real E.164 phone number stored on auth.users.

insert into public.user_memberships (user_id, branch_id, role, is_active)
select id, null, 'super_admin', true
from auth.users
where phone = '+91XXXXXXXXXX'
on conflict do nothing;

-- Confirm that exactly one active owner membership exists.
select users.phone, memberships.role, memberships.is_active
from public.user_memberships memberships
join auth.users users on users.id = memberships.user_id
where memberships.role = 'super_admin' and memberships.is_active = true;
