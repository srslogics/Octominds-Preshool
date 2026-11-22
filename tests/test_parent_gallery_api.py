"""Image validation, private proxying, retry safety and API boundaries."""
import io
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch
from uuid import uuid4

import httpx
from PIL import Image
from fastapi import HTTPException
from fastapi.testclient import TestClient
from api.main import app
from api.auth import CurrentUser, Role, get_current_user
from api.school.router import SchoolRepository, repository
from api.parents.gallery import normalize_photo, PhotoStorage, process_upload, MAX_UPLOAD


def image_bytes(fmt='JPEG', size=(64, 48), exif=False):
    image = Image.new('RGB', size, '#78ab91')
    out = io.BytesIO()
    if exif:
        metadata = Image.Exif(); metadata[270] = 'Private identifying metadata'; metadata[274] = 6
        image.save(out, format=fmt, exif=metadata)
    else:
        image.save(out, format=fmt)
    return out.getvalue()


class GalleryAPI(unittest.TestCase):
    def setUp(self):
        self.repo = Mock(spec=SchoolRepository)
        self.repo.request.return_value = {'status': 'draft', 'can_manage': True}
        self.user = CurrentUser(str(uuid4()), 'teacher@test.invalid', None, Role.TEACHER, str(uuid4()))
        app.dependency_overrides[get_current_user] = lambda: self.user
        app.dependency_overrides[repository] = lambda: self.repo
        self.client = TestClient(app)
        self.album, self.photo, self.student = [str(uuid4()) for _ in range(3)]

    def tearDown(self):
        self.client.close(); app.dependency_overrides.clear()

    def test_all_gallery_routes_require_authentication(self):
        app.dependency_overrides.clear()
        for method, path in [('GET', f'/children/{self.student}/gallery'),('POST','/albums'),('GET',f'/albums/{self.album}'),('POST',f'/albums/{self.album}/publish'),('POST',f'/albums/{self.album}/photos/{self.photo}'),('GET',f'/photos/{self.photo}/image'),('DELETE',f'/albums/{self.album}'),('DELETE',f'/albums/{self.album}/photos/{self.photo}'),('GET','/gallery/staff'),('GET','/gallery/cleanup'),('POST',f'/albums/{self.album}/cleanup')]:
            self.assertEqual(self.client.request(method,'/api/v1/parents'+path).status_code,401)

    def test_album_validation_and_gallery_paging(self):
        data={'class_id':str(uuid4()),'title':' A school day ','taken_on':'2026-11-21'}
        for bad in [{'title':' '},{'taken_on':'bad'},{'created_by':str(uuid4())}]:
            self.assertEqual(self.client.post('/api/v1/parents/albums',json={**data,**bad}).status_code,422)
        self.repo.request.assert_not_called()
        self.assertEqual(self.client.post('/api/v1/parents/albums',json=data).status_code,201)
        self.assertEqual(self.repo.request.call_args.kwargs['data']['p_data']['title'],'A school day')
        self.assertEqual(self.client.get(f'/api/v1/parents/children/{self.student}/gallery?page=0').status_code,422)

    def test_upload_authorizes_before_reading_or_decoding(self):
        self.repo.request.return_value={'status':'published','can_manage':True}
        with patch('api.parents.gallery.normalize_photo') as decode:
            self.assertEqual(self.client.post(f'/api/v1/parents/albums/{self.album}/photos/{self.photo}',content=b'not an image').status_code,403)
            decode.assert_not_called()

    def test_empty_oversized_and_fake_uploads_are_rejected(self):
        url=f'/api/v1/parents/albums/{self.album}/photos/{self.photo}'
        self.assertEqual(self.client.post(url,content=b'').status_code,422)
        self.assertEqual(self.client.post(url,content=b'x'*(MAX_UPLOAD+1)).status_code,413)
        self.assertEqual(self.client.post(url,content=b'<svg onload="alert(1)"/>',headers={'Content-Type':'image/jpeg'}).status_code,422)

    def test_upload_generates_immutable_full_and_thumbnail_then_finishes(self):
        self.repo.request.side_effect=[{'status':'draft','can_manage':True},{'status':'pending'},{'id':self.photo,'status':'ready'}]
        with patch('api.parents.gallery.PhotoStorage') as storage:
            result=self.client.post(f'/api/v1/parents/albums/{self.album}/photos/{self.photo}',content=image_bytes('PNG'),headers={'X-Photo-Caption':'A%20happy%20day'})
            self.assertEqual(result.status_code,201)
            self.assertEqual(storage.return_value.upload.call_count,2)
            self.assertTrue(storage.return_value.upload.call_args_list[0].args[0].endswith('/full.jpg'))
            self.assertTrue(storage.return_value.upload.call_args_list[1].args[0].endswith('/thumb.jpg'))
            self.assertEqual(self.repo.request.call_args.args[1],'/rpc/parents_finish_photo')

    def test_already_completed_upload_does_not_write_storage_again(self):
        self.repo.request.return_value={'status':'ready','id':self.photo}
        with patch('api.parents.gallery.PhotoStorage') as storage:
            process_upload(self.repo,self.album,self.photo,image_bytes(),'')
            storage.assert_not_called()

    def test_download_checks_current_child_access_and_sets_private_headers(self):
        self.repo.request.return_value={'path':f'{self.album}/{self.photo}'}
        with patch('api.parents.gallery.PhotoStorage') as storage:
            storage.return_value.download.return_value=image_bytes(exif=True)
            response=self.client.get(f'/api/v1/parents/photos/{self.photo}/image?student_id={self.student}')
            self.assertEqual(response.status_code,200)
            self.assertEqual(response.headers['content-type'],'image/jpeg')
            self.assertIn('no-store',response.headers['cache-control'])
            self.assertEqual(response.headers['x-content-type-options'],'nosniff')
            self.assertEqual(self.repo.request.call_args.kwargs['data']['p_student'],self.student)
            self.assertEqual(len(Image.open(io.BytesIO(response.content)).getexif()),0)
        self.repo.request.side_effect=HTTPException(403,'No child access')
        with patch('api.parents.gallery.PhotoStorage') as storage:
            self.assertEqual(self.client.get(f'/api/v1/parents/photos/{self.photo}/image').status_code,403)
            storage.assert_not_called()

    def test_withdraw_hides_metadata_before_cleanup_and_reports_outage(self):
        self.repo.request.return_value={'id':self.album,'paths':['album/photo/full.jpg']}
        with patch('api.parents.gallery.PhotoStorage') as storage:
            storage.return_value.delete.return_value=False
            response=self.client.delete(f'/api/v1/parents/albums/{self.album}')
            self.assertEqual(response.status_code,200)
            self.assertTrue(response.json()['cleanup_pending'])
            self.assertEqual(self.repo.request.call_args.kwargs['data']['p_action'],'withdraw')


class ImageSafety(unittest.TestCase):
    def test_orientation_metadata_and_sizes(self):
        full,thumb,w,h=normalize_photo(image_bytes(size=(2500,1800),exif=True))
        self.assertLessEqual(max(w,h),2048)
        self.assertGreater(h,w,'EXIF orientation must be applied before resizing')
        for raw in [full,thumb]:
            image=Image.open(io.BytesIO(raw)); self.assertEqual(image.format,'JPEG');self.assertEqual(len(image.getexif()),0)
            self.assertNotIn(b'Private identifying',raw)
        self.assertLessEqual(max(Image.open(io.BytesIO(thumb)).size),480)

    def test_supported_formats_and_transparency(self):
        for fmt in ['JPEG','PNG','WEBP']:
            full,_,_,_=normalize_photo(image_bytes(fmt));self.assertEqual(Image.open(io.BytesIO(full)).format,'JPEG')
        raw=io.BytesIO();Image.new('RGBA',(10,10),(0,0,0,0)).save(raw,format='PNG')
        full,_,_,_=normalize_photo(raw.getvalue());self.assertEqual(Image.open(io.BytesIO(full)).getpixel((0,0)),(255,255,255))

    def test_corrupt_animated_and_excessive_pixel_images(self):
        for raw in [b'<svg/>',image_bytes()[:100]]:
            with self.assertRaises(HTTPException):normalize_photo(raw)
        out=io.BytesIO();Image.new('RGB',(5,5),'red').save(out,format='PNG',save_all=True,append_images=[Image.new('RGB',(5,5),'blue')])
        with self.assertRaises(HTTPException):normalize_photo(out.getvalue())
        with patch('api.parents.gallery.MAX_PIXELS',1):
            with self.assertRaises(HTTPException):normalize_photo(image_bytes())

    def test_storage_preserves_caller_and_recovers_lost_upload_success(self):
        repo=SimpleNamespace(settings=SimpleNamespace(supabase_url='http://127.0.0.1:54321',supabase_anon_key='public'),token='caller')
        raw=image_bytes();real_client=httpx.Client
        def handler(req):
            self.assertEqual(req.headers['authorization'],'Bearer caller')
            self.assertEqual(req.headers['apikey'],'public')
            if req.method=='POST':
                self.assertEqual(req.headers['x-upsert'],'false')
                return httpx.Response(400,json={'message':'Asset already exists'})
            return httpx.Response(200,content=raw)
        with patch('api.parents.gallery.httpx.Client',side_effect=lambda **kw:real_client(transport=httpx.MockTransport(handler),**kw)):
            PhotoStorage(repo).upload('album/photo/full.jpg',raw)
            with self.assertRaises(HTTPException) as error:PhotoStorage(repo).upload('album/photo/full.jpg',b'different bytes')
            self.assertEqual(error.exception.status_code,409)
