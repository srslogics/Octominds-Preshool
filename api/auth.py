"""Account sessions backed by hashed opaque tokens in the application database."""
import re
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from enum import StrEnum
from time import time
from typing import Annotated

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings, get_settings
from .turso.db import token_hash, transaction

MOBILE_LOGIN_SUFFIX = '@auth.octominds.invalid'


def normalize_mobile(value):
    number = re.sub(r'[\s()-]', '', value)
    match = re.fullmatch(r'(?:\+?91)?([6-9][0-9]{9})', number)
    return match[1] if match else None


def mobile_login(number):
    return f'{number}{MOBILE_LOGIN_SUFFIX}'


def mobile_from_login(email):
    if email.endswith(MOBILE_LOGIN_SUFFIX):
        number = email.removesuffix(MOBILE_LOGIN_SUFFIX)
        return number if re.fullmatch(r'[6-9][0-9]{9}', number) else None
    return None


class Role(StrEnum):
    SUPER_ADMIN = 'super_admin'
    MANAGEMENT = 'management'
    BRANCH_ADMIN = 'branch_admin'
    TEACHER = 'teacher'
    ADMISSION_COUNSELLOR = 'admission_counsellor'
    ACCOUNTANT = 'accountant'
    PARENT = 'parent'


MOBILE_INVITATION_ROLES = {Role.PARENT, Role.TEACHER}


@dataclass(frozen=True)
class CurrentUser:
    id: str
    email: str
    phone: str | None
    role: Role
    branch_id: str | None
    full_name: str | None = None
    branch_name: str | None = None
    branch_roles: dict[str, str] | None = None

    @property
    def role_label(self):
        return self.role.value.replace('_', ' ').title()

    def session_details(self):
        return {**asdict(self), 'role_label': self.role_label}


bearer = HTTPBearer(auto_error=False)
Credentials = Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]


def session_params(token):
    if not token or len(token) > 256:
        raise HTTPException(401, 'Authentication required')
    return token_hash(token), int(time())


SESSION_ACCOUNT = """
    from auth_sessions s join accounts a on a.id=s.user_id join profiles p on p.id=a.id
"""
VALID_SESSION = """
    s.token_hash=? and s.expires_at>? and p.is_active=1 and a.email_confirmed_at is not null
"""


def resolve_account(db, token):
    account = db.one(f'select p.*, a.email, a.email_confirmed_at {SESSION_ACCOUNT} where {VALID_SESSION}',
                     session_params(token))
    if not account:
        raise HTTPException(401, 'Your session expired. Please sign in again.')
    return account


def _resolve_memberships(memberships):
    priority = {role: i for i, role in enumerate((Role.SUPER_ADMIN, Role.MANAGEMENT,
        Role.BRANCH_ADMIN, Role.ACCOUNTANT, Role.TEACHER, Role.ADMISSION_COUNSELLOR, Role.PARENT))}
    active = [m for m in memberships if m.get('role') in priority and (
        not m.get('expires_at') or datetime.fromisoformat(m['expires_at'].replace('Z', '+00:00')) > datetime.now(UTC))]
    active.sort(key=lambda m: (priority[m['role']], str(m.get('branch_id') or '')))
    scopes = {}
    for membership in active:
        scope = '*' if membership['role'] in ('super_admin', 'management') else membership.get('branch_id')
        if scope:
            scopes.setdefault(scope, membership['role'])
    if not scopes:
        raise PermissionError('School access is not assigned to this account')
    return Role(active[0]['role']), scopes


def get_current_user(credentials: Credentials, settings: Annotated[Settings, Depends(get_settings)]):
    if not credentials:
        raise HTTPException(401, 'Authentication required')
    with transaction(settings) as db:
        user, _ = resolve_user_and_memberships(db, credentials.credentials)
        return user


def resolve_user_and_memberships(db, token):
    rows = db.all(f"""
        select p.id account_id,p.full_name,p.phone,a.email,b.name branch_name,m.*
        {SESSION_ACCOUNT}
        left join user_memberships m on m.user_id=p.id and m.is_active=1
            and (m.expires_at is null or julianday(m.expires_at)>julianday('now'))
            and (m.role in ('super_admin','management') or exists (
                select 1 from branches where id=m.branch_id and is_active=1))
        left join branches b on b.id=m.branch_id
        where {VALID_SESSION}
        """, session_params(token))
    if not rows:
        raise HTTPException(401, 'Your session expired. Please sign in again.')
    try:
        role, scopes = _resolve_memberships(rows)
    except PermissionError as exc:
        raise HTTPException(403, str(exc)) from exc
    branch = next(iter(scopes)) if '*' not in scopes and len(scopes) == 1 else None
    account = rows[0]
    branch_name = next((row['branch_name'] for row in rows if row['branch_id'] == branch), None) if branch else None
    user = CurrentUser(account['account_id'], account['email'], account['phone'], role, branch,
                       account['full_name'], branch_name, scopes)
    return user, [row for row in rows if row['role']]
