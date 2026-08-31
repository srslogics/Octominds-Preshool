from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from ..config import Settings
from .errors import InventoryError


class InventoryRepository:
    def __init__(self, settings: Settings, access_token: str):
        self.base_url = f"{settings.supabase_url}/rest/v1"
        self.headers = {
            "apikey": settings.supabase_anon_key,
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        }

    def _request(self, method: str, path: str, *, params: dict[str, Any] | None = None, json: Any = None, prefer: str | None = None) -> tuple[Any, httpx.Headers]:
        headers = dict(self.headers)
        if prefer:
            headers["Prefer"] = prefer
        try:
            with httpx.Client(base_url=self.base_url, headers=headers, timeout=12.0) as client:
                response = client.request(method, path, params=params, json=json)
        except httpx.HTTPError as exc:
            raise InventoryError("inventory_service_unavailable", "Inventory data service is temporarily unavailable", 503) from exc
        if response.status_code >= 400:
            payload = response.json() if response.content else {}
            server_message = str(payload.get("message") or payload.get("details") or "")
            mapping = {
                "insufficient_stock": ("insufficient_stock", "There is not enough stock for this movement", 409),
                "inventory_access_denied": ("inventory_access_denied", "You do not have permission to change this inventory", 403),
                "inventory_item_not_found": ("inventory_item_not_found", "The selected inventory item is unavailable", 404),
                "inventory_location_not_found": ("inventory_location_not_found", "The selected inventory location is unavailable", 404),
                "opening_balance_already_exists": ("opening_balance_already_exists", "Opening balance can only be posted when current stock is zero", 409),
                "inventory_transfer_same_location": ("inventory_transfer_same_location", "Choose a different destination location", 422),
                "use_inventory_transfer_command": ("use_inventory_transfer_command", "Location transfers must use the transfer workflow", 422),
            }
            for marker, (code, message, status_code) in mapping.items():
                if marker in server_message:
                    raise InventoryError(code, message, status_code)
            if response.status_code == 409 or payload.get("code") == "23505":
                raise InventoryError("inventory_conflict", "This inventory code or SKU already exists", 409)
            raise InventoryError("inventory_request_failed", "The inventory request could not be completed", min(response.status_code, 500))
        payload = response.json() if response.content else None
        return payload, response.headers

    def list_rows(self, table: str, params: dict[str, Any]) -> tuple[list[dict], int]:
        payload, headers = self._request("GET", f"/{table}", params=params, prefer="count=exact")
        content_range = headers.get("content-range", "*/0")
        try:
            total = int(content_range.rsplit("/", 1)[-1])
        except ValueError:
            total = len(payload or [])
        return payload or [], total

    def create_row(self, table: str, data: dict[str, Any]) -> dict:
        payload, _ = self._request("POST", f"/{table}", json=data, prefer="return=representation")
        if not payload:
            raise InventoryError("inventory_write_failed", "The inventory record was not created", 500)
        return payload[0]

    def update_item(self, item_id: str, data: dict[str, Any]) -> dict:
        payload, _ = self._request(
            "PATCH",
            "/inventory_items",
            params={"id": f"eq.{item_id}"},
            json=data,
            prefer="return=representation",
        )
        if not payload:
            raise InventoryError("inventory_item_not_found", "The inventory item was not found", 404)
        return payload[0]

    def post_movement(self, data: dict[str, Any]) -> dict:
        payload, _ = self._request("POST", "/rpc/post_inventory_movement", json=data)
        if not payload:
            raise InventoryError("inventory_write_failed", "The stock movement was not posted", 500)
        return payload[0]

    def transfer_stock(self, data: dict[str, Any]) -> dict:
        payload, _ = self._request("POST", "/rpc/transfer_inventory_stock", json=data)
        if not payload:
            raise InventoryError("inventory_write_failed", "The stock transfer was not posted", 500)
        return payload[0]
