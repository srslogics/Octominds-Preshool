from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated

import jwt
import httpx
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from .config import Settings, get_settings


class Role(StrEnum):
    SUPER_ADMIN = "super_admin"
    MANAGEMENT = "management"
    BRANCH_ADMIN = "branch_admin"
    TEACHER = "teacher"
    ADMISSION_COUNSELLOR = "admission_counsellor"
    ACCOUNTANT = "accountant"
    PARENT = "parent"


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
    def role_label(self) -> str:
        return self.role.value.replace("_", " ").title()


bearer = HTTPBearer(auto_error=False)


def _decode_token(token: str, settings: Settings) -> dict:
    algorithm = jwt.get_unverified_header(token).get("alg")

    if algorithm == "HS256":
        if not settings.supabase_jwt_secret:
            raise ValueError("Supabase JWT secret is not configured")
        return jwt.decode(token, settings.supabase_jwt_secret, algorithms=["HS256"], audience="authenticated")

    if algorithm not in {"RS256", "ES256"}:
        raise ValueError("Unsupported access token algorithm")
    if not settings.supabase_url:
        raise ValueError("Supabase is not configured")
    jwks_client = jwt.PyJWKClient(f"{settings.supabase_url}/auth/v1/.well-known/jwks.json")
    signing_key = jwks_client.get_signing_key_from_jwt(token)
    return jwt.decode(token, signing_key.key, algorithms=[algorithm], audience="authenticated")


def _load_auth_claims(token: str, settings: Settings) -> dict:
    headers = {"apikey": settings.supabase_anon_key, "Authorization": f"Bearer {token}"}
    with httpx.Client(base_url=settings.supabase_url, headers=headers, timeout=8.0) as client:
        response = client.get("/auth/v1/user")
        response.raise_for_status()
        user = response.json()
    return {
        "sub": user["id"],
        "email": user.get("email", ""),
        "phone": user.get("phone"),
    }


def _validated_claims(token: str, settings: Settings) -> dict:
    try:
        return _decode_token(token, settings)
    except (jwt.PyJWTError, ValueError):
        return _load_auth_claims(token, settings)


def _resolve_memberships(memberships: list[dict]) -> tuple[Role, dict[str, str]]:
    priority = {Role.SUPER_ADMIN: 0, Role.MANAGEMENT: 1, Role.BRANCH_ADMIN: 2, Role.ACCOUNTANT: 3}
    valid = [m for m in memberships if m.get('role') in priority]
    if not valid:
        raise PermissionError('Inventory access is not assigned to this account')
    valid.sort(key=lambda m: (priority[m['role']], str(m.get('branch_id') or '')))
    roles: dict[str, str] = {}
    for membership in valid:
        role = membership['role']
        scope = '*' if role in {Role.SUPER_ADMIN, Role.MANAGEMENT} else membership.get('branch_id')
        if scope and scope not in roles:
            roles[scope] = role
    if not roles:
        raise PermissionError('No inventory center is assigned')
    return Role(valid[0]['role']), roles


def _load_access_profile(token: str, user_id: str, settings: Settings) -> tuple[Role, str | None, str | None, str | None, dict[str, str]]:
    headers = {"apikey": settings.supabase_anon_key, "Authorization": f"Bearer {token}"}
    with httpx.Client(base_url=f"{settings.supabase_url}/rest/v1", headers=headers, timeout=8.0) as client:
        profile_response = client.get("/profiles", params={"id": f"eq.{user_id}", "select": "full_name,is_active", "limit": 1})
        profile_response.raise_for_status()
        profiles = profile_response.json()
        if not profiles or not profiles[0].get("is_active"):
            raise PermissionError("User profile is inactive or missing")

        memberships = []
        while True:
            membership_response = client.get('/user_memberships', params={
                'user_id': f'eq.{user_id}', 'is_active': 'eq.true', 'select': 'role,branch_id',
                'order': 'id.asc', 'limit': 500, 'offset': len(memberships),
            })
            membership_response.raise_for_status()
            rows = membership_response.json()
            if not rows:
                break
            memberships.extend(rows)
        role, branch_roles = _resolve_memberships(memberships)
        branch_id = next(iter(branch_roles)) if '*' not in branch_roles and len(branch_roles) == 1 else None
        branch_name = None
        if branch_id:
            branch_response = client.get("/branches", params={"id": f"eq.{branch_id}", "select": "name", "limit": 1})
            branch_response.raise_for_status()
            branches = branch_response.json()
            branch_name = branches[0]["name"] if branches else None
        return role, branch_id, profiles[0].get("full_name"), branch_name, branch_roles


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> CurrentUser:
    if not credentials or not settings.supabase_url or not settings.supabase_anon_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")

    try:
        claims = _validated_claims(credentials.credentials, settings)
        role, branch_id, full_name, branch_name, branch_roles = _load_access_profile(credentials.credentials, claims["sub"], settings)
        return CurrentUser(
            id=claims["sub"],
            email=claims.get("email", ""),
            phone=claims.get("phone"),
            role=role,
            branch_id=branch_id,
            full_name=full_name,
            branch_name=branch_name,
            branch_roles=branch_roles,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code >= 500 or exc.response.status_code == 429:
            raise HTTPException(status_code=503, detail="Authentication service is temporarily unavailable") from exc
        raise HTTPException(status_code=401, detail="Invalid access token") from exc
    except httpx.RequestError as exc:
        raise HTTPException(status_code=503, detail="Authentication service is temporarily unavailable") from exc
    except (jwt.PyJWTError, KeyError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token") from exc


def require_roles(*allowed: Role):
    def dependency(user: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
        if user.role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
        return user

    return dependency
