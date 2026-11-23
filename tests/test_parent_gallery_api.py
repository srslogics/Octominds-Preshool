"""Image validation, private proxying, retry safety and API boundaries."""
import io
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from PIL import Image
from fastapi import HTTPException
from fastapi.testclient import TestClient
from api.main import app
from api.auth import CurrentUser, Role, get_current_user
from api.school.router import SchoolRepository, repository
from api.parents.gallery import normalize_photo, MAX_UPLOAD


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
        for method, path in [('GET', f'/children/{self.student}/gallery'),('POST','/albums'),('GET',f'/albums/{self.album}'),('POST',f'/albums/{self.album}/publish'),('POST',f'/albums/{self.album}/photos/{self.photo}'),('GET',f'/photos/{self.photo}/image'),('DELETE',f'/albums/{self.album}'),('DELETE',f'/albums/{self.album}/photos/{self.photo}'),('GET','/gallery/staff')]:
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
