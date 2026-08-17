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


def _load_access_profile(token: str, user_id: str, settings: Settings) -> tuple[Role, str | None, str | None, str | None]:
    headers = {"apikey": settings.supabase_anon_key, "Authorization": f"Bearer {token}"}
    with httpx.Client(base_url=f"{settings.supabase_url}/rest/v1", headers=headers, timeout=8.0) as client:
        profile_response = client.get("/profiles", params={"id": f"eq.{user_id}", "select": "full_name,is_active", "limit": 1})
        profile_response.raise_for_status()
        profiles = profile_response.json()
        if not profiles or not profiles[0].get("is_active"):
            raise PermissionError("User profile is inactive or missing")

        membership_response = client.get(
            "/user_memberships",
            params={"user_id": f"eq.{user_id}", "is_active": "eq.true", "select": "role,branch_id", "limit": 1},
        )
        membership_response.raise_for_status()
        memberships = membership_response.json()
        if not memberships:
            raise PermissionError("No active OctoMinds membership")
        membership = memberships[0]
        branch_id = membership.get("branch_id")
        branch_name = None
        if branch_id:
            branch_response = client.get("/branches", params={"id": f"eq.{branch_id}", "select": "name", "limit": 1})
            branch_response.raise_for_status()
            branches = branch_response.json()
            branch_name = branches[0]["name"] if branches else None
        return Role(membership["role"]), branch_id, profiles[0].get("full_name"), branch_name


def get_current_user(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
) -> CurrentUser:
    if not credentials or not settings.supabase_url or not settings.supabase_anon_key:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authentication required")

    try:
        claims = _decode_token(credentials.credentials, settings)
        role, branch_id, full_name, branch_name = _load_access_profile(credentials.credentials, claims["sub"], settings)
        return CurrentUser(
            id=claims["sub"],
            email=claims.get("email", ""),
            phone=claims.get("phone"),
            role=role,
            branch_id=branch_id,
            full_name=full_name,
            branch_name=branch_name,
        )
    except PermissionError as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc
    except (jwt.PyJWTError, httpx.HTTPError, KeyError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid access token") from exc


def require_roles(*allowed: Role):
    def dependency(user: Annotated[CurrentUser, Depends(get_current_user)]) -> CurrentUser:
        if user.role not in allowed:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Insufficient permissions")
        return user

    return dependency
