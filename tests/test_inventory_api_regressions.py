"""API/service regression tests: python -m unittest discover -s tests -p 'test_*.py'."""
import unittest
from unittest.mock import patch
from uuid import uuid4

import httpx
from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from api.auth import CurrentUser, Role, _resolve_memberships, get_current_user
from api.inventory.permissions import resolve_branch
from api.config import Settings
from api.inventory.errors import InventoryError
from api.inventory.repository import InventoryRepository
from api.inventory.router import _json, update_item
from api.inventory.schemas import ItemUpdate
from api.inventory.service import InventoryService


class InventoryRegressions(unittest.TestCase):
    def test_memberships_are_order_independent_and_center_scoped(self):
        a, b = str(uuid4()), str(uuid4())
        memberships = [{'role': 'teacher', 'branch_id': a},
                       {'role': 'accountant', 'branch_id': b},
                       {'role': 'branch_admin', 'branch_id': a}]
        role, scopes = _resolve_memberships(memberships)
        self.assertEqual((role, scopes), _resolve_memberships(list(reversed(memberships))))
        user = CurrentUser('test', '', None, role, None, branch_roles=scopes)
        self.assertEqual(resolve_branch(user, a, write=True), a)
        self.assertEqual(resolve_branch(user, b), b)
        for center, write in [(b, True), (str(uuid4()), False), (None, True)]:
            with self.assertRaises(HTTPException):
                resolve_branch(user, center, write=write)

    def test_all_rows_respects_upstream_page_cap(self):
        repository = InventoryRepository(self.settings(), 'test')
        with patch.object(repository, 'list_rows', side_effect=[([{'id': 1}], 2), ([{'id': 2}], 2)]) as rows:
            self.assertEqual(len(repository.all_rows('items', {})), 2)
        self.assertEqual(rows.call_args.args[1]['offset'], 1)

    def test_readiness_requires_auth_and_migrated_database(self):
        from api.main import app
        from api.config import get_settings
        from fastapi.testclient import TestClient
        config = self.settings()
        app.dependency_overrides[get_settings] = lambda: config
        real_client = httpx.Client
        try:
            for healthy in [True, False]:
                transport = httpx.MockTransport(lambda req: httpx.Response(200, json=
                    {'schema_version': '202610260001', 'ready': healthy}))
                with TestClient(app) as client:
                    with patch('api.main.httpx.Client', side_effect=lambda **kw: real_client(transport=transport, **kw)):
                        response = client.get('/ready')
                self.assertEqual(response.status_code, 200 if healthy else 503)
        finally:
            app.dependency_overrides.clear()

    def test_history_pagination_and_transfer_filter(self):
        repository = InventoryRepository(self.settings(), 'test')
        with patch.object(repository, 'list_rows', return_value=([], 0)) as rows:
            InventoryService(repository).list_movements('center', 25, 50, 'transfer')
        params = rows.call_args.args[1]
        self.assertEqual(params['offset'], 50)
        self.assertEqual(params['branch_id'], 'eq.center')
        self.assertEqual(params['movement_type'], 'in.(transfer_in,transfer_out)')

    def test_item_details_keep_center_scope(self):
        repository = InventoryRepository(self.settings(), 'test')
        with patch.object(repository, 'read_report', return_value={}) as rows:
            InventoryService(repository).list_items('center', '', 'all', 1, 1, 'item')
        self.assertEqual(rows.call_args.args[1]['p_item_id'], 'item')
        self.assertEqual(rows.call_args.args[1]['p_branch_id'], 'center')

    def settings(self):
        return Settings(_env_file=None, supabase_anon_key='test-public-key')

    def test_nullable_fields_can_be_cleared(self):
        changes = ItemUpdate(description=None, standard_cost=None).model_dump(exclude_unset=True)
        self.assertEqual(_json(changes, keep_nulls=True), {'description': None, 'standard_cost': None})

    def test_item_patch_is_scoped_to_resolved_center(self):
        item, branch = str(uuid4()), str(uuid4())
        repository = InventoryRepository(self.settings(), 'test-token')
        with patch.object(repository, '_request', return_value=([{'id': item}], {})) as request:
            InventoryService(repository).update_item(item, branch, {'description': None})
        self.assertEqual(request.call_args.kwargs['params'], {'id': f'eq.{item}', 'branch_id': f'eq.{branch}'})
        self.assertIsNone(request.call_args.kwargs['json']['description'])

    def test_route_rejects_null_required_field(self):
        with patch('api.inventory.router.resolve_branch', return_value=str(uuid4())):
            with self.assertRaises(HTTPException) as raised:
                update_item(uuid4(), ItemUpdate(name=None), None, None, None, self.settings(), uuid4())
        self.assertEqual(raised.exception.status_code, 422)

    def test_auth_outage_is_not_invalid_credentials(self):
        with patch('api.auth._validated_claims', return_value={'sub': 'test-user'}), \
             patch('api.auth._load_access_profile', side_effect=httpx.ConnectError('offline')):
            with self.assertRaises(HTTPException) as raised:
                get_current_user(HTTPAuthorizationCredentials(scheme='Bearer', credentials='test'), self.settings())
        self.assertEqual(raised.exception.status_code, 503)

    def test_html_gateway_error_is_handled(self):
        real_client = httpx.Client
        transport = httpx.MockTransport(lambda request: httpx.Response(502, text='<html>Bad gateway</html>'))
        with patch('api.inventory.repository.httpx.Client', side_effect=lambda **kw: real_client(transport=transport, **kw)):
            with self.assertRaises(InventoryError) as raised:
                InventoryRepository(self.settings(), 'test').list_rows('inventory_items', {})
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == '__main__':
    unittest.main()
