"""API/service regression tests: python -m unittest discover -s tests -p 'test_*.py'."""
import unittest
from unittest.mock import patch
from uuid import uuid4

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials

from api.auth import CurrentUser, Role, _resolve_memberships, get_current_user
from api.inventory.permissions import resolve_branch
from api.config import Settings
from api.inventory.router import _json, update_item
from api.inventory.schemas import ItemUpdate


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

    def test_nullable_fields_can_be_cleared(self):
        changes = ItemUpdate(description=None, standard_cost=None).model_dump(exclude_unset=True)
        self.assertEqual(_json(changes, keep_nulls=True), {'description': None, 'standard_cost': None})

    def test_route_rejects_null_required_field(self):
        with patch('api.inventory.router.resolve_branch', return_value=str(uuid4())):
            with self.assertRaises(HTTPException) as raised:
                update_item(uuid4(), ItemUpdate(name=None), None, None, None, Settings(_env_file=None), uuid4())
        self.assertEqual(raised.exception.status_code, 422)

    def test_database_outage_is_not_invalid_credentials(self):
        with patch('api.turso.db.connect', side_effect=ValueError('offline')):
            with self.assertRaises(HTTPException) as raised:
                get_current_user(HTTPAuthorizationCredentials(scheme='Bearer', credentials='test'), Settings(_env_file=None))
        self.assertEqual(raised.exception.status_code, 503)


if __name__ == '__main__':
    unittest.main()
