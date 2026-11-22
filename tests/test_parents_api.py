"""Parent API validation and credential boundaries; SQL tests cover authorization."""
import unittest
from unittest.mock import Mock
from uuid import uuid4
from fastapi.testclient import TestClient
from api.auth import CurrentUser, Role, get_current_user
from api.main import app
from api.school.router import SchoolRepository, repository


class ParentsAPI(unittest.TestCase):
    def setUp(self):
        self.repo = Mock(spec=SchoolRepository)
        self.repo.request.return_value = {'students': [], 'classes': [], 'guardians': [], 'parent_accounts': []}
        self.user = CurrentUser(str(uuid4()), 'parent@test.invalid', None, Role.PARENT, str(uuid4()))
        app.dependency_overrides[get_current_user] = lambda: self.user
        app.dependency_overrides[repository] = lambda: self.repo
        self.client = TestClient(app)
        self.student = str(uuid4())

    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()

    def test_workspace_is_not_cached_and_uses_guarded_rpc(self):
        response = self.client.get('/api/v1/parents/workspace')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.repo.request.assert_called_once_with('POST', '/rpc/parents_workspace', data={})

    def test_every_endpoint_requires_sign_in(self):
        app.dependency_overrides.clear()
        for method, path, data in [
            ('GET', '/workspace', None), ('GET', f'/children/{self.student}/posts', None),
            ('GET', f'/children/{self.student}/calendar?month=2026-11-01', None),
            ('GET', f'/children/{self.student}/messages', None),
            ('POST', f'/children/{self.student}/messages', {'body': 'Hello'}),
            ('POST', '/students', {}), ('POST', '/guardians', {}), ('POST', '/posts', {}),
            ('DELETE', f'/posts/{self.student}', None)]:
            self.assertEqual(self.client.request(method, '/api/v1/parents'+path, json=data).status_code, 401)

    def test_feed_filters_and_pagination_are_bounded(self):
        for query in ['kind=private', 'page=0', 'page=10001']:
            self.assertEqual(self.client.get(f'/api/v1/parents/children/{self.student}/posts?{query}').status_code, 422)
        self.repo.request.assert_not_called()
        self.client.get(f'/api/v1/parents/children/{self.student}/posts?kind=homework&page=2')
        self.assertEqual(self.repo.request.call_args.kwargs['data'], {'p_student': self.student, 'p_kind': 'homework', 'p_page': 2})

    def test_messages_reject_blank_oversized_or_forged_author(self):
        for data in [{'body': '  '}, {'body': 'x'*2001}, {'body': 'Hi', 'author_id': str(uuid4())}]:
            self.assertEqual(self.client.post(f'/api/v1/parents/children/{self.student}/messages', json=data).status_code, 422)
        self.repo.request.assert_not_called()
        self.assertEqual(self.client.post(f'/api/v1/parents/children/{self.student}/messages', json={'body': ' Hello '}).status_code, 201)
        self.assertEqual(self.repo.request.call_args.kwargs['data'], {'p_student': self.student, 'p_body': 'Hello'})

    def test_student_edit_requires_version_and_rejects_metadata(self):
        data = {'branch_id': str(uuid4()), 'class_id': str(uuid4()), 'full_name': 'A child'}
        for extra in [{'id': self.student}, {'created_by': str(uuid4())}, {'full_name': ' '}]:
            self.assertEqual(self.client.post('/api/v1/parents/students', json={**data, **extra}).status_code, 422)
        self.repo.request.assert_not_called()
        self.assertEqual(self.client.post('/api/v1/parents/students', json={**data, 'id': self.student, 'version': 1}).status_code, 200)

    def test_event_dates_and_extra_fields_are_validated(self):
        data = {'class_id': str(uuid4()), 'kind': 'event', 'title': 'Family morning', 'body': 'Join us'}
        self.assertEqual(self.client.post('/api/v1/parents/posts', json=data).status_code, 422)
        self.assertEqual(self.client.post('/api/v1/parents/posts', json={**data, 'kind': 'notice', 'event_date': '2026-11-21'}).status_code, 422)
        self.assertEqual(self.client.post('/api/v1/parents/posts', json={**data, 'event_date': '2026-11-21', 'created_by': str(uuid4())}).status_code, 422)
        self.repo.request.assert_not_called()
        self.assertEqual(self.client.post('/api/v1/parents/posts', json={**data, 'event_date': '2026-11-21'}).status_code, 201)

    def test_calendar_and_ids_are_validated(self):
        self.assertEqual(self.client.get(f'/api/v1/parents/children/{self.student}/calendar?month=garbage').status_code, 422)
        self.assertEqual(self.client.get('/api/v1/parents/children/not-a-uuid/posts').status_code, 422)
        self.repo.request.assert_not_called()
        self.client.get(f'/api/v1/parents/children/{self.student}/calendar?month=2026-11-01')
        self.assertEqual(self.repo.request.call_args.kwargs['data']['p_month'], '2026-11-01')
