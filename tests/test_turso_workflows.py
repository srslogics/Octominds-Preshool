"""Exercise the replacement datastore through the existing HTTP contract."""
import io
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from uuid import uuid4

from fastapi.testclient import TestClient
from PIL import Image

from api.config import Settings, get_settings
from api.main import app
from api.turso.accounts import hasher
from api.turso.db import initialize, now, transaction


class TursoWorkflows(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.settings = Settings(_env_file=None, sqlite_path=str(Path(self.tmp.name)/'school.db'),
                                 frontend_origin='http://127.0.0.1:8000', mail_from='test@example.invalid', resend_api_key='fixture')
        initialize(self.settings)
        app.dependency_overrides[get_settings] = lambda: self.settings
        self.addCleanup(app.dependency_overrides.clear)
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.owner_id = self.account('owner@example.invalid', 'super_admin')
        self.owner = self.login('owner@example.invalid')
        self.center = self.school('centers',{'name':'Green Park','code':'GP'})['id']
        self.other_center = self.school('centers',{'name':'Lake Road','code':'LR'})['id']
        self.year = self.school('years',{'branch_id':self.center,'name':'Current','starts_on':'2020-01-01',
                                         'ends_on':'2070-12-31','status':'active'})['id']
        program = self.school('programs',{'branch_id':self.center,'name':'Nursery'})['id']
        self.classroom = self.school('classes',{'branch_id':self.center,'name':'Nursery','program_id':program,
                                      'academic_year_id':self.year,'capacity':20})['id']
        self.teacher_id = self.account('teacher@example.invalid','teacher',self.center)
        self.school('assignments',{'branch_id':self.center,'class_id':self.classroom,'user_id':self.teacher_id,
                                    'starts_on':'2020-01-01','ends_on':'2070-12-31'})
        self.teacher = self.login('teacher@example.invalid')
        self.parent_id = self.account('parent@example.invalid','parent',self.center)
        self.parent = self.login('parent@example.invalid')
        self.unlinked = self.login('unlinked@example.invalid', create_role='parent')
        self.child = self.request('POST','/parents/students',self.owner,{'branch_id':self.center,
                    'class_id':self.classroom,'full_name':'Fixture Child'}).json()['id']
        self.guardian = {'student_id':self.child,'user_id':self.parent_id,'relationship':'Guardian'}
        self.request('POST','/parents/guardians',self.owner,self.guardian)

    def account(self,email,role=None,branch=None):
        with transaction(self.settings,write=True) as db:
            account=db.insert('accounts',{'email':email,'password_hash':hasher.hash('correct-test-password'),
                                          'email_confirmed_at':now()})
            db.insert('profiles',{'id':account['id'],'full_name':email.split('@')[0]})
            if role:
                db.insert('user_memberships',{'user_id':account['id'],'role':role,'branch_id':branch})
            return account['id']

    def login(self,email,create_role=None):
        if create_role: self.account(email,create_role,self.center)
        return self.request('POST','/auth/token?grant_type=password',data={'email':email,'password':'correct-test-password'}).json()

    def request(self,method,path,session=None,data=None,code=200,**kwargs):
        headers=kwargs.pop('headers',{})
        if session: headers['Authorization']='Bearer '+session['access_token']
        response=self.client.request(method,'/api/v1'+path,headers=headers,json=data,**kwargs)
        self.assertEqual(response.status_code,code,response.text[:500])
        return response

    def school(self,kind,data):
        return self.request('POST','/school/records/'+kind,self.owner,{'data':data}).json()

    def test_child_scope_messages_and_revocation(self):
        self.assertEqual([s['id'] for s in self.request('GET','/parents/workspace',self.parent).json()['students']],[self.child])
        self.assertEqual(self.request('GET','/parents/workspace',self.unlinked).json()['students'],[])
        feed=f'/parents/children/{self.child}/posts'
        self.request('GET',feed,self.unlinked,code=403)
        post={'class_id':self.classroom,'kind':'diary','title':'Class update','body':'Synthetic diary entry'}
        self.request('POST','/parents/posts',self.parent,post,code=403)
        self.request('POST','/parents/posts',self.teacher,post,code=201)
        self.assertEqual(self.request('GET',feed,self.parent).json()['total'],1)
        thread=f'/parents/children/{self.child}/messages'
        self.request('POST',thread,self.parent,{'body':'Synthetic message'},code=201)
        self.assertEqual(self.request('GET',thread,self.teacher).json()['messages'][0]['body'],'Synthetic message')
        self.request('POST','/parents/guardians',self.owner,{**self.guardian,'is_active':False})
        self.request('GET',feed,self.parent,code=403)
        self.request('GET',thread,self.parent,code=403)

    def test_private_photo_transaction_and_retry(self):
        album=self.request('POST','/parents/albums',self.teacher,{'class_id':self.classroom,'title':'Test Album',
                           'taken_on':'2026-11-23'},code=201).json()['id']
        photo=str(uuid4())
        upload=f'/parents/albums/{album}/photos/{photo}'
        media=f'/parents/photos/{photo}/image?student_id={self.child}'
        out=io.BytesIO()
        Image.new('RGB',(120,90),'pink').save(out,'PNG')
        self.request('POST',upload,self.parent,content=out.getvalue(),code=403)
        first=self.request('POST',upload,self.teacher,content=out.getvalue(),code=201).json()
        self.assertEqual(self.request('POST',upload,self.teacher,content=out.getvalue(),code=201).json(),first)
        self.request('GET',media,self.parent,code=403)
        self.request('POST',f'/parents/albums/{album}/publish',self.teacher,{})
        image=self.request('GET',media,self.parent)
        self.assertEqual(image.headers['content-type'],'image/jpeg')
        self.assertIn('no-store',image.headers['cache-control'])
        self.assertEqual(Image.open(io.BytesIO(image.content)).size,(120,90))
        self.request('GET',media,self.unlinked,code=403)
        self.request('DELETE',upload,self.teacher)
        self.request('GET',media,self.parent,code=403)
        with transaction(self.settings) as db:
            self.assertEqual(db.scalar('select count(*) from photo_chunks where photo_id=?',(photo,)),0)

    def test_inventory_concurrency_retry_and_access(self):
        category=self.request('POST','/inventory/categories',self.owner,{'branch_id':self.center,'name':'Books','code':'BK'},code=201).json()['id']
        other=self.request('POST','/inventory/categories',self.owner,{'branch_id':self.other_center,'name':'Art','code':'AR'},code=201).json()['id']
        locations=[self.request('POST','/inventory/locations',self.owner,{'branch_id':self.center,'name':name,'code':name},code=201).json()['id']
                   for name in ['Store','Office']]
        item={'branch_id':self.center,'category_id':category,'name':'Picture book','sku':'BOOK','standard_cost':'9.95'}
        self.request('POST','/inventory/items',self.owner,{**item,'category_id':other},code=422)
        item_id=self.request('POST','/inventory/items',self.owner,item,code=201).json()['id']
        self.request('GET','/inventory/items',self.parent,code=403)
        self.request('GET','/inventory/items',self.teacher,code=403)
        lookups = self.request('GET',f'/inventory/lookups?branch_id={self.center}',self.owner).json()
        self.assertEqual({row['id'] for row in lookups['branches']}, {self.center,self.other_center})
        self.assertEqual([row['id'] for row in lookups['categories']], [category])
        stock={'branch_id':self.center,'item_id':item_id,'location_id':locations[0],
               'movement_type':'receipt','quantity':'10.125','unit_cost':'9.95','idempotency_key':'receipt-key-1'}
        def receipt(_):
            return self.request('POST','/inventory/movements',self.owner,stock,code=201).json()['movement_id']
        with ThreadPoolExecutor(2) as pool:
            self.assertEqual(len(set(pool.map(receipt, range(2)))),1)
        self.request('POST','/inventory/movements',self.owner,{**stock,'quantity':'10.126'},code=409)
        transfer={'branch_id':self.center,'item_id':item_id,'from_location_id':locations[0],
                  'to_location_id':locations[1],'quantity':'2.345','idempotency_key':'transfer-key-1'}
        result=self.request('POST','/inventory/transfers',self.owner,transfer,code=201).json()
        self.assertEqual(result['from_quantity_after'],'7.78')
        self.assertEqual(result['to_quantity_after'],'2.345')
        self.assertEqual(self.request('POST','/inventory/transfers',self.owner,transfer,code=201).json(),result)
        self.assertEqual(self.request('GET','/inventory/movements?movement_type=transfer',self.owner).json()['total'],2)
        detail=self.request('GET',f'/inventory/items/{item_id}?branch_id={self.center}',self.owner).json()
        self.assertEqual(detail['quantity_on_hand'],10.125)
        self.assertEqual(detail['standard_cost'],9.95)
        self.request('PATCH',f'/inventory/items/{item_id}?branch_id={self.center}',self.owner,{'unit':'box'},code=409)
        self.request('PATCH',f'/inventory/items/{item_id}?branch_id={self.center}',self.owner,{'is_active':False},code=409)

    def test_invite_email_ownership_and_rotating_sessions(self):
        invitation=self.request('POST','/school/access/invite',self.owner,{'branch_id':self.center,'role':'parent',
                    'email':'invite@example.invalid','full_name':'Invited Person'}).json()
        token=invitation['token']
        self.request('POST','/school/accept-invitation',self.parent,{'token':token},code=403)
        with patch('api.turso.accounts.send_email') as mail:
            self.request('POST','/auth/signup',data={'email':'invite@example.invalid','invitation_token':token})
            code=mail.call_args.args[-1]
        account=self.request('POST','/auth/reset',data={'code':code,'password':'new-strong-password'}).json()
        self.request('POST','/auth/reset',data={'code':code,'password':'replayed-password'},code=403)
        self.request('GET','/session',account,code=403)
        self.request('POST','/school/accept-invitation',account,{'token':token})
        self.request('POST','/school/accept-invitation',account,{'token':token},code=403)
        self.assertEqual(self.request('GET','/session',account).json()['role'],'parent')
        body={'refresh_token':account['refresh_token']}
        refreshed=self.request('POST','/auth/token?grant_type=refresh_token',data=body).json()
        self.request('GET','/session',account,code=401)
        self.request('POST','/auth/token?grant_type=refresh_token',data=body,code=401)
        self.request('POST','/auth/logout',refreshed,code=204)
        self.request('GET','/session',refreshed,code=401)

    def test_mobile_parent_invitation_and_child_link(self):
        invite = '/school/access/invite'
        claim = '/auth/claim-mobile-invitation'
        details = {'branch_id': self.center, 'role': 'parent', 'full_name': 'Mobile Parent'}
        self.request('POST', invite, self.owner, {**details, 'phone': '+1 98765 43210'}, code=422)
        self.request('POST', invite, self.owner, {**details, 'role': 'teacher', 'phone': '9876543210'}, code=422)
        self.request('POST', invite, self.owner, {**details, 'phone': '9876543210', 'email': 'parent@example.invalid'}, code=422)
        self.request('POST', invite, self.owner, {**details, 'email': '9876543210@auth.octominds.invalid'}, code=422)
        self.request('POST', invite, self.teacher, {**details, 'phone': '9876543210'}, code=403)
        invitation = self.request('POST', invite, self.owner, {**details, 'phone': '+91 98765 43210'}).json()
        revocable = self.request('POST', invite, self.owner, {**details, 'phone': '9123456780'}).json()
        self.request('POST', '/school/access/revoke_invite', self.owner, {'id': revocable['id']})
        self.request('POST', claim, data={'phone': '9123456780', 'pin': '539176',
                     'invitation_token': revocable['token']}, code=403)
        signup = {'phone': '9876543210', 'pin': '539176', 'invitation_token': invitation['token']}
        self.request('POST', claim, data={**signup, 'phone': '9876543211'}, code=403)
        self.request('POST', claim, data={**signup, 'pin': '1234'}, code=422)
        with patch('api.turso.accounts.email_enabled', return_value=False):
            parent = self.request('POST', claim, data=signup).json()
        self.request('POST', claim, data=signup, code=403)
        parent_info = self.request('GET', '/session', parent).json()
        self.assertEqual((parent_info['role'], parent_info['phone']), ('parent', '9876543210'))
        self.assertEqual(self.request('GET', '/parents/workspace', parent).json()['students'], [])
        directory = self.request('GET', '/school/access', self.owner).json()
        self.assertEqual(next(i for i in directory['invitations'] if i['id'] == invitation['id'])['phone'], '9876543210')
        candidates = self.request('GET', '/parents/workspace', self.owner).json()['parent_accounts']
        self.assertEqual(next(a for a in candidates if a['user_id'] == parent_info['id'])['phone'], '9876543210')
        self.request('POST', '/parents/guardians', self.owner, {**self.guardian, 'user_id': parent_info['id']})
        login = {'email': '9876543210@auth.octominds.invalid', 'password': signup['pin']}
        refreshed = self.request('POST', '/auth/token?grant_type=password', data=login).json()
        children = self.request('GET', '/parents/workspace', refreshed).json()['students']
        self.assertEqual([child['id'] for child in children], [self.child])

    def test_existing_number_accepts_an_invitation_with_its_current_pin(self):
        email = '9123456780@auth.octominds.invalid'
        user_id = self.account(email, 'parent', self.center)
        with transaction(self.settings, write=True) as db:
            db.update('accounts', user_id, {'password_hash': hasher.hash('539176')})
        invite = {'phone': '9123456780', 'full_name': 'Different Name', 'role': 'parent'}
        session = self.request('POST', '/auth/token?grant_type=password',
                               data={'email': email, 'password': '539176'}).json()
        for branch in (self.other_center, self.center):
            invitation = self.request('POST', '/school/access/invite', self.owner,
                                      {**invite, 'branch_id': branch}).json()
            self.request('POST', '/auth/claim-mobile-invitation',
                         data={'phone': invite['phone'], 'pin': '654321', 'invitation_token': invitation['token']},
                         code=409)
            self.request('POST', '/school/accept-invitation', session, {'token': invitation['token']})
        self.request('POST', '/auth/token?grant_type=password', data={'email': email, 'password': '539176'})
        profile = self.request('GET', '/session', session).json()
        self.assertEqual(profile['full_name'], '9123456780')
        self.assertEqual(set(profile['branch_roles']), {self.center, self.other_center})

    def test_enrollment_details_prefill_and_mobile_invitation_connects_child(self):
        student = self.request('POST', '/parents/students', self.owner, {
            'branch_id': self.center, 'class_id': self.classroom, 'full_name': 'New Student',
            'guardian': {'full_name': 'New Guardian', 'phone': '+91 98765 43210', 'relationship': 'Mother'},
        }).json()
        self.assertEqual(self.request('GET', '/school/workspace', self.teacher).json()['students'], [])
        enrollments = self.request('GET', '/school/workspace', self.owner).json()['students']
        self.assertEqual(next(row for row in enrollments if row['id'] == student['id'])['guardian'],
                         {'full_name': 'New Guardian', 'phone': '9876543210', 'email': None, 'relationship': 'Mother'})
        invitation = {'role': 'parent', 'full_name': 'New Guardian', 'phone': '9876543210',
                      'student_id': student['id'], 'relationship': 'Mother'}
        self.request('POST', '/school/access/invite', self.owner,
                     {**invitation, 'branch_id': self.other_center}, code=422)
        result = self.request('POST', '/school/access/invite', self.owner,
                              {**invitation, 'branch_id': self.center}).json()
        parent = self.request('POST', '/auth/claim-mobile-invitation', data={
            'phone': invitation['phone'], 'pin': '539176', 'invitation_token': result['token'],
        }).json()
        children = self.request('GET', '/parents/workspace', parent).json()['students']
        self.assertEqual([(row['id'], row['relationship']) for row in children], [(student['id'], 'Mother')])
        self.request('GET', f'/parents/children/{self.child}/posts', parent, code=403)
        self.request('POST', '/parents/posts', self.teacher, {
            'class_id': self.classroom, 'student_id': student['id'], 'kind': 'diary', 'title': 'Today', 'body': 'Test update',
        }, code=201)
        self.assertEqual(self.request('GET', f"/parents/children/{student['id']}/posts", parent).json()['total'], 1)

    def test_existing_parent_can_be_connected_to_student_added_before_upgrade(self):
        with transaction(self.settings, write=True) as db:
            db.execute('drop table school_invitation_students')
            db.execute('drop table student_guardian_contacts')
        initialize(self.settings, bootstrap=False)
        initialize(self.settings, bootstrap=False)
        students = self.request('GET', '/school/workspace', self.owner).json()['students']
        self.assertIsNone(next(row for row in students if row['id'] == self.child)['guardian'])
        parent_id = self.request('GET', '/session', self.unlinked).json()['id']
        self.request('POST', '/school/access/grant', self.owner, {
            'branch_id': self.center, 'role': 'parent', 'user_id': parent_id,
            'student_id': self.child, 'relationship': 'Guardian',
        })
        children = self.request('GET', '/parents/workspace', self.unlinked).json()['students']
        self.assertEqual([row['id'] for row in children], [self.child])

    def test_readiness_config_and_distinct_center_permissions(self):
        response=self.client.get('/ready')
        self.assertEqual(response.status_code,200)
        self.assertNotIn('turso',self.client.get('/config.js').text.lower())
        self.assertEqual(self.request('GET','/school/workspace',self.teacher).json()['centers'][0]['id'],self.center)
        self.request('POST','/school/records/programs',self.teacher,{'data':{'branch_id':self.other_center,'name':'Other'}},code=403)
