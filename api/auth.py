"""Account sessions backed by hashed opaque tokens in the application database."""
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from time import time
from typing import Annotated

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings, get_settings
from .turso.access import Access
from .turso.db import token_hash, transaction


class Role(StrEnum):
    SUPER_ADMIN = 'super_admin'
    MANAGEMENT = 'management'
    BRANCH_ADMIN = 'branch_admin'
    TEACHER = 'teacher'
    ADMISSION_COUNSELLOR = 'admission_counsellor'
    ACCOUNTANT = 'accountant'
    PARENT = 'parent'


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


bearer = HTTPBearer(auto_error=False)
Credentials = Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)]


def resolve_account(db, token):
    if not token or len(token) > 256:
        raise HTTPException(401, 'Authentication required')
    account = db.one("""
        select p.*, a.email, a.email_confirmed_at from auth_sessions s
        join accounts a on a.id=s.user_id join profiles p on p.id=a.id
        where s.token_hash=? and s.expires_at>? and p.is_active=1 and a.email_confirmed_at is not null
        """, (token_hash(token), int(time())))
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
        account = resolve_account(db, credentials.credentials)
        access = Access(db, account['id'])
        try:
            role, scopes = _resolve_memberships([m for m in access.memberships
                if m['role'] in ('super_admin', 'management') or access.active(m['branch_id'])])
        except PermissionError as exc:
            raise HTTPException(403, str(exc)) from exc
        branch = next(iter(scopes)) if '*' not in scopes and len(scopes) == 1 else None
        return CurrentUser(account['id'], account['email'], account['phone'], role, branch,
                           account['full_name'], access.branches.get(branch, {}).get('name'), scopes)
