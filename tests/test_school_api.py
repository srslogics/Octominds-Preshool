"""School API boundaries; database authorization is covered by integration tests."""
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4
import httpx
from fastapi import HTTPException
from fastapi.testclient import TestClient
from api.auth import CurrentUser, Role, get_current_user, _resolve_memberships
from api.config import Settings
from api.main import app
from api.school.router import SchoolRepository, repository

class SchoolAPI(unittest.TestCase):
    def setUp(self):
        self.branch, self.uid = str(uuid4()), str(uuid4())
        self.repo = Mock(spec=SchoolRepository)
        self.user = CurrentUser(self.uid, 'admin@test.invalid', None, Role.BRANCH_ADMIN, self.branch)
        app.dependency_overrides[repository] = lambda: self.repo
        app.dependency_overrides[get_current_user] = lambda: self.user
        self.client = TestClient(app)
        self.repo.request.return_value = {'id': str(uuid4()), 'version': 1}
    def tearDown(self):
        self.client.close()
        app.dependency_overrides.clear()
    def test_center_details_cannot_smuggle_archive_or_unsupported_fields(self):
        response = self.client.post('/api/v1/school/records/centers',json={'data':{'name':'Center A','code':'a'}})
        self.assertEqual(response.status_code,200)
        data = self.repo.request.call_args.kwargs['data']['p_data']
        self.assertEqual(data['code'],'A')
        self.assertNotIn('is_active',data)
        self.assertNotIn('website',data)
        for extra in [{'is_active':False},{'created_by':self.uid},{'working_days':[1,1]},{'timezone':'Invalid/Zone'}]:
            self.repo.request.reset_mock()
            response = self.client.post('/api/v1/school/records/centers',json={'data':{'name':'A','code':'A',**extra}})
            self.assertIn(response.status_code,[403,422])
            self.repo.request.assert_not_called()
    def test_edit_requires_version_and_preserves_it(self):
        data={'branch_id':self.branch,'name':'Nursery'}
        identity=str(uuid4())
        self.assertEqual(self.client.post('/api/v1/school/records/programs',json={'id':identity,'data':data}).status_code,422)
        self.assertEqual(self.client.post('/api/v1/school/records/programs',json={'id':identity,'version':4,'data':data}).status_code,200)
        self.assertEqual(self.repo.request.call_args.kwargs['data']['p_version'],4)
    def test_invitation_acceptance_does_not_require_existing_membership(self):
        def no_membership():
            raise HTTPException(403,'Not assigned')
        app.dependency_overrides[get_current_user]=no_membership
        self.assertEqual(self.client.post('/api/v1/school/accept-invitation',json={'token':'a'*64}).status_code,200)
        self.assertEqual(self.client.get('/api/v1/school/workspace').status_code,403)
        self.assertEqual(self.client.post('/api/v1/school/accept-invitation',json={'token':'bad'}).status_code,422)
    def test_directory_and_validation_boundaries(self):
        self.user=CurrentUser(self.uid,'teacher@test.invalid',None,Role.TEACHER,self.branch)
        self.assertEqual(self.client.get('/api/v1/school/access').status_code,403)
        self.assertEqual(self.client.post('/api/v1/school/access/invite',json={'email':'not-an-email','role':'teacher','full_name':'Teacher'}).status_code,422)
        self.repo.request.assert_not_called()
    def test_repository_preserves_bearer_and_maps_failures(self):
        real_client=httpx.Client
        config=Settings(_env_file=None,supabase_anon_key='public-key')
        def handler(req):
            self.assertEqual(req.headers['authorization'],'Bearer caller-token')
            self.assertEqual(req.headers['apikey'],'public-key')
            return httpx.Response(500,json={'code':'40001','message':'stale'})
        with patch('api.school.router.httpx.Client',side_effect=lambda **kw:real_client(transport=httpx.MockTransport(handler),**kw)):
            with self.assertRaises(HTTPException) as error:SchoolRepository(config,'caller-token').request('POST','/rpc/school_save_record',data={})
        self.assertEqual(error.exception.status_code,409)
    def test_pagination_continues_past_gateway_cap(self):
        repo=SchoolRepository(Settings(_env_file=None),'token')
        with patch.object(repo,'request',side_effect=[[{'id':'1'}],[{'id':'2'}],[]]) as request:
            self.assertEqual(len(repo.rows('branches')),2)
            self.assertEqual(request.call_args.kwargs['params']['offset'],2)
    def test_expired_roles_do_not_win_role_resolution(self):
        role,scope=_resolve_memberships([{'role':'branch_admin','branch_id':self.branch,'expires_at':'2000-01-01T00:00:00Z'},{'role':'teacher','branch_id':self.branch}])
        self.assertEqual(role,Role.TEACHER)
        self.assertEqual(scope[self.branch],'teacher')

if __name__=='__main__':unittest.main()
