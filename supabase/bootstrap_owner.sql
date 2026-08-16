-- Run this after the owner is created in Supabase Auth using their phone
-- number and six-digit PIN as the password. Replace the placeholder with
-- the owner's E.164 mobile number, for example +91XXXXXXXXXX.

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
