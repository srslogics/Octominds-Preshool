from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .repository import InventoryRepository


class InventoryService:
    def __init__(self, repository: InventoryRepository):
        self.repository = repository

    def lookups(self, branch_id: str | None) -> dict:
        branch_filter = {"branch_id": f"eq.{branch_id}"} if branch_id else {}
        branch_params: dict[str, Any] = {"select": "id,name,code", "is_active": "eq.true", "order": "name.asc,id.asc"}
        branches = self.repository.all_rows("branches", branch_params)
        categories = self.repository.all_rows(
            "inventory_categories",
            {"select": "id,branch_id,name,code", "is_active": "eq.true", "order": "name.asc,id.asc", **branch_filter},
        )
        locations = self.repository.all_rows(
            "inventory_locations",
            {"select": "id,branch_id,name,code,location_type", "is_active": "eq.true", "order": "name.asc,id.asc", **branch_filter},
        )
        items = self.repository.all_rows(
            "inventory_items",
            {"select": "id,branch_id,name,sku,unit", "is_active": "eq.true", "order": "name.asc,id.asc", **branch_filter},
        )
        return {"branches": branches, "categories": categories, "locations": locations, "items": items}

    def create_center(self, data: dict[str, Any]) -> dict:
        return self.repository.create_center(data)

    def list_items(self, branch_id: str | None, search: str, stock_status: str, page: int, page_size: int, item_id: str | None = None) -> dict:
        return self.repository.read_report("inventory_read_items", {
            "p_branch_id": branch_id, "p_search": search, "p_stock_status": stock_status,
            "p_page": page, "p_page_size": page_size, "p_item_id": item_id,
        })

    def dashboard(self, branch_id: str | None) -> dict:
        return self.repository.read_report("inventory_read_dashboard", {"p_branch_id": branch_id})

    def list_movements(self, branch_id: str | None, limit: int, offset: int = 0, movement_type: str = "all") -> dict:
        params: dict[str, Any] = {
            "select": "id,branch_id,movement_type,quantity,signed_quantity,quantity_after,reference,notes,posted_at,inventory_items(name,sku,unit),inventory_locations(name)",
            "order": "posted_at.desc,id.desc",
            "limit": limit,
            "offset": offset,
        }
        if branch_id:
            params["branch_id"] = f"eq.{branch_id}"
        if movement_type == "transfer":
            params["movement_type"] = "in.(transfer_in,transfer_out)"
        elif movement_type != "all":
            params["movement_type"] = f"eq.{movement_type}"
        rows, total = self.repository.list_rows("inventory_movements", params)
        for row in rows:
            item = row.pop("inventory_items", {}) or {}
            location = row.pop("inventory_locations", {}) or {}
            row.update(item_name=item.get("name"), sku=item.get("sku"), unit=item.get("unit"), location_name=location.get("name"))
        return {"movements": rows, "total": total}

    def create_category(self, data: dict[str, Any], user_id: str) -> dict:
        return self.repository.create_row("inventory_categories", {**data, "created_by": user_id})

    def create_location(self, data: dict[str, Any], user_id: str) -> dict:
        return self.repository.create_row("inventory_locations", {**data, "created_by": user_id})

    def create_item(self, data: dict[str, Any], user_id: str) -> dict:
        return self.repository.create_row("inventory_items", {**data, "created_by": user_id})

    def update_item(self, item_id: str, branch_id: str, data: dict[str, Any]) -> dict:
        return self.repository.update_item(item_id, branch_id, {**data, "updated_at": datetime.now(UTC).isoformat()})

    def post_movement(self, data: dict[str, Any]) -> dict:
        rpc_data = {f"p_{key}": value for key, value in data.items()}
        return self.repository.post_movement(rpc_data)

    def transfer_stock(self, data: dict[str, Any]) -> dict:
        rpc_data = {f"p_{key}": value for key, value in data.items()}
        return self.repository.transfer_stock(rpc_data)
