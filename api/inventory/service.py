"""Inventory API operations."""
from .repository import InventoryRepository


class InventoryService:
    def __init__(self, repository: InventoryRepository):
        self.repository = repository

    def lookups(self, branch_id):
        return self.repository.lookups(branch_id)

    def create_center(self, data):
        return self.repository.create_center(data)

    def list_items(self, branch_id, search, stock_status, page, page_size, item_id=None):
        return self.repository.list_items(branch_id, search, stock_status, page, page_size, item_id)

    def dashboard(self, branch_id, *, include_overview=False):
        return self.repository.dashboard(branch_id, include_overview=include_overview)

    def list_movements(self, branch_id, limit, offset=0, movement_type='all'):
        return self.repository.list_movements(branch_id, limit, offset, movement_type)

    def create_category(self, data, user_id):
        return self.repository.create_row('inventory_categories', data)

    def create_location(self, data, user_id):
        return self.repository.create_row('inventory_locations', data)

    def create_item(self, data, user_id):
        return self.repository.create_row('inventory_items', data)

    def update_item(self, item_id, branch_id, data):
        return self.repository.update_item(item_id, branch_id, data)

    def post_movement(self, data):
        return self.repository.stock_command('movement', data)

    def transfer_stock(self, data):
        return self.repository.stock_command('transfer', data)
