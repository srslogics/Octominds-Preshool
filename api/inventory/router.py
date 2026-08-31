from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.security import HTTPAuthorizationCredentials

from ..auth import CurrentUser, bearer, get_current_user
from ..config import Settings, get_settings
from .errors import InventoryError
from .permissions import resolve_branch
from .repository import InventoryRepository
from .schemas import (
    CategoryCreate,
    InventoryDashboard,
    ItemCreate,
    ItemListResponse,
    ItemUpdate,
    LocationCreate,
    LookupResponse,
    MovementCreate,
    MovementListResponse,
    MovementResult,
    TransferCreate,
    TransferResult,
)
from .service import InventoryService

router = APIRouter(prefix="/api/v1/inventory", tags=["inventory"])


def _service(credentials: HTTPAuthorizationCredentials, settings: Settings) -> InventoryService:
    return InventoryService(InventoryRepository(settings, credentials.credentials))


def _json(data: dict) -> dict:
    return {key: str(value) if isinstance(value, (UUID, Decimal)) else value for key, value in data.items() if value is not None}


def _raise_domain_error(error: InventoryError, request: Request) -> None:
    request_id = request.headers.get("X-Request-ID")
    raise HTTPException(
        status_code=error.status_code,
        detail={"code": error.code, "message": error.message, "request_id": request_id},
    ) from error


@router.get("/dashboard", response_model=InventoryDashboard)
def dashboard(
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
    branch_id: UUID | None = None,
):
    branch = resolve_branch(user, branch_id)
    try:
        return _service(credentials, settings).dashboard(branch)
    except InventoryError as error:
        _raise_domain_error(error, request)


@router.get("/lookups", response_model=LookupResponse)
def lookups(
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
    branch_id: UUID | None = None,
):
    branch = resolve_branch(user, branch_id)
    try:
        return _service(credentials, settings).lookups(branch)
    except InventoryError as error:
        _raise_domain_error(error, request)


@router.get("/items", response_model=ItemListResponse)
def list_items(
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
    branch_id: UUID | None = None,
    search: str = Query(default="", max_length=80),
    stock_status: Literal["all", "low", "out", "healthy"] = "all",
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=25, ge=1, le=100),
):
    branch = resolve_branch(user, branch_id)
    try:
        return _service(credentials, settings).list_items(branch, search, stock_status, page, page_size)
    except InventoryError as error:
        _raise_domain_error(error, request)


@router.post("/categories", status_code=201)
def create_category(
    payload: CategoryCreate,
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    resolve_branch(user, payload.branch_id, write=True)
    try:
        return _service(credentials, settings).create_category(_json(payload.model_dump()), user.id)
    except InventoryError as error:
        _raise_domain_error(error, request)


@router.post("/locations", status_code=201)
def create_location(
    payload: LocationCreate,
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    resolve_branch(user, payload.branch_id, write=True)
    try:
        return _service(credentials, settings).create_location(_json(payload.model_dump()), user.id)
    except InventoryError as error:
        _raise_domain_error(error, request)


@router.post("/items", status_code=201)
def create_item(
    payload: ItemCreate,
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    resolve_branch(user, payload.branch_id, write=True)
    try:
        return _service(credentials, settings).create_item(_json(payload.model_dump()), user.id)
    except InventoryError as error:
        _raise_domain_error(error, request)


@router.patch("/items/{item_id}")
def update_item(
    item_id: UUID,
    payload: ItemUpdate,
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
    branch_id: UUID | None = None,
):
    resolve_branch(user, branch_id, write=True)
    try:
        return _service(credentials, settings).update_item(str(item_id), _json(payload.model_dump(exclude_unset=True)))
    except InventoryError as error:
        _raise_domain_error(error, request)


@router.post("/movements", response_model=MovementResult, status_code=201)
def post_movement(
    payload: MovementCreate,
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    resolve_branch(user, payload.branch_id, write=True)
    try:
        return _service(credentials, settings).post_movement(_json(payload.model_dump()))
    except InventoryError as error:
        _raise_domain_error(error, request)


@router.post("/transfers", response_model=TransferResult, status_code=201)
def transfer_stock(
    payload: TransferCreate,
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
):
    resolve_branch(user, payload.branch_id, write=True)
    try:
        return _service(credentials, settings).transfer_stock(_json(payload.model_dump()))
    except InventoryError as error:
        _raise_domain_error(error, request)


@router.get("/movements", response_model=MovementListResponse)
def list_movements(
    request: Request,
    user: Annotated[CurrentUser, Depends(get_current_user)],
    credentials: Annotated[HTTPAuthorizationCredentials, Depends(bearer)],
    settings: Annotated[Settings, Depends(get_settings)],
    branch_id: UUID | None = None,
    limit: int = Query(default=12, ge=1, le=100),
):
    branch = resolve_branch(user, branch_id)
    try:
        return _service(credentials, settings).list_movements(branch, limit)
    except InventoryError as error:
        _raise_domain_error(error, request)
