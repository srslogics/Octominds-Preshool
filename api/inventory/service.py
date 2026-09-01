from __future__ import annotations

from datetime import UTC, datetime
from typing import Any

from .repository import InventoryRepository


def _numeric(value: Any) -> float:
    return float(value or 0)


class InventoryService:
    def __init__(self, repository: InventoryRepository):
        self.repository = repository

    def lookups(self, branch_id: str | None) -> dict:
        branch_filter = {"branch_id": f"eq.{branch_id}"} if branch_id else {}
        branch_params: dict[str, Any] = {"select": "id,name,code", "is_active": "eq.true", "order": "name.asc"}
        branches, _ = self.repository.list_rows("branches", branch_params)
        categories, _ = self.repository.list_rows(
            "inventory_categories",
            {"select": "id,branch_id,name,code", "is_active": "eq.true", "order": "name.asc", **branch_filter},
        )
        locations, _ = self.repository.list_rows(
            "inventory_locations",
            {"select": "id,branch_id,name,code,location_type", "is_active": "eq.true", "order": "name.asc", **branch_filter},
        )
        items, _ = self.repository.list_rows(
            "inventory_items",
            {"select": "id,branch_id,name,sku,unit", "is_active": "eq.true", "order": "name.asc", "limit": 5000, **branch_filter},
        )
        return {"branches": branches, "categories": categories, "locations": locations, "items": items}

    def create_center(self, data: dict[str, Any]) -> dict:
        return self.repository.create_center(data)

    def list_items(self, branch_id: str | None, search: str, stock_status: str, page: int, page_size: int) -> dict:
        params: dict[str, Any] = {
            "select": "id,branch_id,category_id,name,sku,description,unit,reorder_level,standard_cost,is_active,inventory_categories(name),inventory_stock_balances(location_id,quantity_on_hand,inventory_locations(name))",
            "is_active": "eq.true",
            "order": "name.asc",
            "offset": (page - 1) * page_size,
            "limit": page_size,
        }
        if branch_id:
            params["branch_id"] = f"eq.{branch_id}"
        if search:
            safe_search = search.replace("%", "").replace(",", " ").strip()[:80]
            params["or"] = f"(name.ilike.*{safe_search}*,sku.ilike.*{safe_search}*)"
        if stock_status != "all":
            params.pop("offset", None)
            params["limit"] = 5000
        rows, total = self.repository.list_rows("inventory_items", params)
        items = []
        for row in rows:
            balances = row.pop("inventory_stock_balances", []) or []
            quantity = sum(_numeric(balance.get("quantity_on_hand")) for balance in balances)
            reorder = _numeric(row.get("reorder_level"))
            status = "out" if quantity <= 0 else "low" if quantity <= reorder else "healthy"
            locations = sorted({(balance.get("inventory_locations") or {}).get("name") for balance in balances if (balance.get("inventory_locations") or {}).get("name")})
            category = row.pop("inventory_categories", None) or {}
            item = {
                **row,
                "category_name": category.get("name"),
                "quantity_on_hand": quantity,
                "stock_status": status,
                "location_names": locations,
            }
            if stock_status == "all" or stock_status == status:
                items.append(item)
        if stock_status != "all":
            total = len(items)
            start = (page - 1) * page_size
            items = items[start:start + page_size]
        return {"items": items, "total": total, "page": page, "page_size": page_size}

    def dashboard(self, branch_id: str | None) -> dict:
        params: dict[str, Any] = {
            "select": "id,reorder_level,is_active,inventory_stock_balances(quantity_on_hand)",
            "is_active": "eq.true",
            "limit": 5000,
        }
        movement_params: dict[str, Any] = {
            "select": "id",
            "posted_at": f"gte.{datetime.now(UTC).date().isoformat()}T00:00:00Z",
            "limit": 1,
        }
        if branch_id:
            params["branch_id"] = movement_params["branch_id"] = f"eq.{branch_id}"
        items, _ = self.repository.list_rows("inventory_items", params)
        _, movement_count = self.repository.list_rows("inventory_movements", movement_params)
        low_stock = out_of_stock = 0
        for item in items:
            quantity = sum(_numeric(balance.get("quantity_on_hand")) for balance in (item.get("inventory_stock_balances") or []))
            if quantity <= 0:
                out_of_stock += 1
            elif quantity <= _numeric(item.get("reorder_level")):
                low_stock += 1
        return {"active_items": len(items), "low_stock": low_stock, "out_of_stock": out_of_stock, "movements_today": movement_count}

    def list_movements(self, branch_id: str | None, limit: int) -> dict:
        params: dict[str, Any] = {
            "select": "id,branch_id,movement_type,quantity,signed_quantity,quantity_after,reference,notes,posted_at,inventory_items(name,sku,unit),inventory_locations(name)",
            "order": "posted_at.desc",
            "limit": limit,
        }
        if branch_id:
            params["branch_id"] = f"eq.{branch_id}"
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

    def update_item(self, item_id: str, data: dict[str, Any]) -> dict:
        return self.repository.update_item(item_id, {**data, "updated_at": datetime.now(UTC).isoformat()})

    def post_movement(self, data: dict[str, Any]) -> dict:
        rpc_data = {f"p_{key}": value for key, value in data.items()}
        return self.repository.post_movement(rpc_data)

    def transfer_stock(self, data: dict[str, Any]) -> dict:
        rpc_data = {f"p_{key}": value for key, value in data.items()}
        return self.repository.transfer_stock(rpc_data)
