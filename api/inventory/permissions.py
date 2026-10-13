from uuid import UUID

from fastapi import HTTPException, status

from ..auth import CurrentUser, Role


INVENTORY_READ_ROLES = {
    Role.SUPER_ADMIN,
    Role.MANAGEMENT,
    Role.BRANCH_ADMIN,
    Role.ACCOUNTANT,
}
INVENTORY_WRITE_ROLES = {
    Role.SUPER_ADMIN,
    Role.MANAGEMENT,
    Role.BRANCH_ADMIN,
}


def require_inventory_access(user: CurrentUser, write: bool = False) -> None:
    allowed = INVENTORY_WRITE_ROLES if write else INVENTORY_READ_ROLES
    if user.role not in allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Inventory access is not assigned to this role")


def resolve_branch(user: CurrentUser, requested_branch: UUID | None, *, write: bool = False) -> str | None:
    require_inventory_access(user, write=write)
    if user.branch_roles is not None:
        requested = str(requested_branch) if requested_branch else user.branch_id
        if requested is None:
            if write:
                raise HTTPException(status_code=422, detail='Select a center before changing inventory')
            return None  # RLS restricts the aggregate to this user's authorized centers.
        role = user.branch_roles.get('*') or user.branch_roles.get(requested)
        allowed = INVENTORY_WRITE_ROLES if write else INVENTORY_READ_ROLES
        if role not in allowed:
            raise HTTPException(status_code=403, detail='Requested center is outside your access for this action')
        return requested
    if user.branch_id:
        if requested_branch and str(requested_branch) != user.branch_id:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Requested center is outside your access")
        return user.branch_id
    if write and requested_branch is None:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Select a center before changing inventory")
    return str(requested_branch) if requested_branch else None
