from decimal import Decimal
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field, field_validator, model_validator


class MovementType(StrEnum):
    OPENING_BALANCE = "opening_balance"
    RECEIPT = "receipt"
    ISSUE = "issue"
    RETURN_IN = "return_in"
    ADJUSTMENT_GAIN = "adjustment_gain"
    ADJUSTMENT_LOSS = "adjustment_loss"


class CategoryCreate(BaseModel):
    branch_id: UUID
    name: str = Field(min_length=2, max_length=80)
    code: str = Field(min_length=2, max_length=20, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]+$")
    description: str | None = Field(default=None, max_length=500)

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        return value.strip().upper()


class LocationCreate(BaseModel):
    branch_id: UUID
    name: str = Field(min_length=2, max_length=80)
    code: str = Field(min_length=2, max_length=20, pattern=r"^[A-Za-z0-9][A-Za-z0-9_-]+$")
    location_type: str = Field(default="branch_store", pattern=r"^(central_store|branch_store|classroom|daycare|office)$")

    @field_validator("code")
    @classmethod
    def normalize_code(cls, value: str) -> str:
        return value.strip().upper()


class ItemCreate(BaseModel):
    branch_id: UUID
    category_id: UUID
    name: str = Field(min_length=2, max_length=120)
    sku: str = Field(min_length=2, max_length=40, pattern=r"^[A-Za-z0-9][A-Za-z0-9._/-]+$")
    description: str | None = Field(default=None, max_length=1000)
    unit: str = Field(default="piece", pattern=r"^(piece|packet|box|set|litre|kilogram|metre|roll)$")
    reorder_level: Decimal = Field(default=Decimal("0"), ge=0, max_digits=14, decimal_places=3)
    standard_cost: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)

    @field_validator("sku")
    @classmethod
    def normalize_sku(cls, value: str) -> str:
        return value.strip().upper()


class ItemUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=2, max_length=120)
    category_id: UUID | None = None
    description: str | None = Field(default=None, max_length=1000)
    unit: str | None = Field(default=None, pattern=r"^(piece|packet|box|set|litre|kilogram|metre|roll)$")
    reorder_level: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=3)
    standard_cost: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    is_active: bool | None = None


class MovementCreate(BaseModel):
    branch_id: UUID
    item_id: UUID
    location_id: UUID
    movement_type: MovementType
    quantity: Decimal = Field(gt=0, max_digits=14, decimal_places=3)
    unit_cost: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)
    reference: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=120)


class TransferCreate(BaseModel):
    branch_id: UUID
    item_id: UUID
    from_location_id: UUID
    to_location_id: UUID
    quantity: Decimal = Field(gt=0, max_digits=14, decimal_places=3)
    reference: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=500)
    idempotency_key: str = Field(min_length=8, max_length=120)

    @model_validator(mode="after")
    def locations_must_differ(self):
        if self.from_location_id == self.to_location_id:
            raise ValueError("Source and destination locations must be different")
        return self


class InventoryDashboard(BaseModel):
    active_items: int
    low_stock: int
    out_of_stock: int
    movements_today: int


class ItemListResponse(BaseModel):
    items: list[dict]
    total: int
    page: int
    page_size: int


class MovementListResponse(BaseModel):
    movements: list[dict]
    total: int


class MovementResult(BaseModel):
    movement_id: UUID
    quantity_after: Decimal


class TransferResult(BaseModel):
    transfer_group_id: UUID
    from_quantity_after: Decimal
    to_quantity_after: Decimal


class LookupResponse(BaseModel):
    branches: list[dict]
    categories: list[dict]
    locations: list[dict]
    items: list[dict]


class InventoryErrorResponse(BaseModel):
    code: str
    message: str
    request_id: str | None = None
