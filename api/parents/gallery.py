"""Private gallery. Images pass through the API; no public or signed URLs are issued."""
import hashlib
import io
import warnings
from datetime import date
from urllib.parse import unquote
from uuid import UUID

import httpx
from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from pydantic import Field
from .router import User, Repo
from ..school.router import Fields

router = APIRouter(prefix='/api/v1/parents', tags=['parent-gallery'])
BUCKET = 'octominds-parent-photos'
MAX_UPLOAD = 10 * 1024 * 1024
MAX_STORED = 6 * 1024 * 1024
MAX_PIXELS = 25_000_000


class Album(Fields):
    class_id: UUID
    student_id: UUID | None = None
    title: str = Field(min_length=1, max_length=160)
    description: str = Field('', max_length=2000)
    taken_on: date


def normalize_photo(raw: bytes):
    """Verify/decode, orient, resize and re-encode without EXIF or other metadata."""
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as probe:
                if probe.format not in {'JPEG', 'PNG', 'WEBP'} or getattr(probe, 'n_frames', 1) != 1:
                    raise HTTPException(422, 'Choose a still JPEG, PNG, or WebP photo.')
                if probe.width * probe.height > MAX_PIXELS:
                    raise HTTPException(422, 'Choose a photo with no more than 25 megapixels.')
                probe.verify()
            with Image.open(io.BytesIO(raw)) as original:
                original.load()
                image = ImageOps.exif_transpose(original).convert('RGBA')
                # Composite transparency on white; only new pixel data is encoded.
                clean = Image.new('RGB', image.size, 'white')
                clean.paste(image, mask=image.getchannel('A'))
                clean.thumbnail((2048, 2048))
                width, height = clean.size
                def encode(size):
                    copy = clean.copy()
                    copy.thumbnail((size, size))
                    output = io.BytesIO()
                    copy.save(output, format='JPEG', quality=85, optimize=True)
                    return output.getvalue()
                full, thumb = encode(2048), encode(480)
                if len(full) > MAX_STORED:
                    raise HTTPException(422, 'This photo is too large after processing. Try a smaller image.')
                return full, thumb, width, height
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise HTTPException(422, 'This file could not be read as a safe photo. Choose a JPEG, PNG, or WebP image.') from exc


class PhotoStorage:
    def __init__(self, repo):
        self.base = f'{repo.settings.supabase_url}/storage/v1'
        self.headers = {'apikey': repo.settings.supabase_anon_key, 'Authorization': f'Bearer {repo.token}'}

    def download(self, path):
        try:
            with httpx.Client(base_url=self.base, headers=self.headers, timeout=20) as client:
                with client.stream('GET', f'/object/authenticated/{BUCKET}/{path}', headers={'Cache-Control': 'no-store'}) as response:
                    if response.status_code != 200:
                        raise HTTPException(503 if response.status_code >= 500 else 404, 'Photo is unavailable. Please refresh or try again.')
                    body = bytearray()
                    for chunk in response.iter_bytes():
                        body.extend(chunk)
                        if len(body) > MAX_STORED:
                            raise HTTPException(502, 'Photo service returned an oversized image.')
                    return bytes(body)
        except httpx.HTTPError as exc:
            raise HTTPException(503, 'Photo service is temporarily unavailable.') from exc

    def upload(self, path, content):
        try:
            with httpx.Client(base_url=self.base, headers=self.headers, timeout=30) as client:
                response = client.post(f'/object/{BUCKET}/{path}', content=content,
                                       headers={'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'x-upsert': 'false'})
            if response.status_code in {200, 201}:
                return
            # An immutable deterministic path makes retries safe, including a lost success response.
            if response.status_code in {400, 409}:
                existing = self.download(path)
                if hashlib.sha256(existing).digest() == hashlib.sha256(content).digest():
                    return
                raise HTTPException(409, 'This photo upload conflicts with existing content. Remove it and choose the file again.')
            raise HTTPException(503 if response.status_code >= 500 else 403, 'The photo could not be uploaded. Check your school access and retry.')
        except httpx.HTTPError as exc:
            raise HTTPException(503, 'The photo upload was interrupted. You can retry this photo safely.') from exc

    def delete(self, paths):
        if not paths:
            return True
        try:
            with httpx.Client(base_url=self.base, headers=self.headers, timeout=20) as client:
                response = client.request('DELETE', f'/object/{BUCKET}', json={'prefixes': paths})
            return response.status_code in {200, 204}
        except httpx.HTTPError:
            return False


@router.get('/children/{student_id}/gallery')
def gallery(student_id: UUID, user: User, repo: Repo, page: int = Query(1, ge=1, le=10000)):
    return repo.request('POST', '/rpc/parents_gallery', data={'p_student': str(student_id), 'p_page': page})


@router.get('/gallery/staff')
def staff_albums(user: User, repo: Repo, page: int = Query(1, ge=1, le=10000)):
    return repo.request('POST', '/rpc/parents_staff_albums', data={'p_page': page})


@router.get('/albums/{album_id}')
def detail(album_id: UUID, user: User, repo: Repo, student_id: UUID | None = None):
    return repo.request('POST', '/rpc/parents_album_detail', data={'p_album': str(album_id), 'p_student': str(student_id) if student_id else None})


@router.post('/albums', status_code=201)
def create_album(body: Album, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_create_album', data={'p_data': body.model_dump(mode='json')})


def process_upload(repo, album_id, photo_id, raw, caption):
    full, thumb, width, height = normalize_photo(raw)
    photo = repo.request('POST', '/rpc/parents_prepare_photo', data={
        'p_album': str(album_id), 'p_photo': str(photo_id), 'p_checksum': hashlib.sha256(full).hexdigest(), 'p_caption': caption})
    if photo['status'] == 'ready':
        return photo
    storage = PhotoStorage(repo)
    prefix = f'{album_id}/{photo_id}'
    storage.upload(f'{prefix}/full.jpg', full)
    storage.upload(f'{prefix}/thumb.jpg', thumb)
    return repo.request('POST', '/rpc/parents_finish_photo', data={
        'p_album': str(album_id), 'p_photo': str(photo_id), 'p_width': width, 'p_height': height})


@router.post('/albums/{album_id}/photos/{photo_id}', status_code=201)
async def upload_photo(album_id: UUID, photo_id: UUID, request: Request, user: User, repo: Repo,
                       x_photo_caption: str = Header('', max_length=2400)):
    try:
        caption = unquote(x_photo_caption, errors='strict').strip()
    except UnicodeError as exc:
        raise HTTPException(422, 'Use a valid photo caption.') from exc
    if len(caption) > 200 or '\x00' in caption:
        raise HTTPException(422, 'Use a caption of up to 200 characters.')
    # Authorize before reading/decoding a potentially large request.
    album = await run_in_threadpool(repo.request, 'POST', '/rpc/parents_album_detail', data={'p_album': str(album_id), 'p_student': None})
    if not album.get('can_manage') or album.get('status') != 'draft':
        raise HTTPException(403, 'Only the school team can upload to a draft album.')
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > MAX_UPLOAD:
            raise HTTPException(413, 'Choose a photo smaller than 10 MiB.')
    if not body:
        raise HTTPException(422, 'Choose a photo to upload.')
    return await run_in_threadpool(process_upload, repo, album_id, photo_id, bytes(body), caption.strip())


@router.get('/photos/{photo_id}/image')
def photo_image(photo_id: UUID, user: User, repo: Repo, student_id: UUID | None = None, thumbnail: bool = False):
    access = repo.request('POST', '/rpc/parents_photo_access', data={'p_photo': str(photo_id), 'p_student': str(student_id) if student_id else None})
    raw = PhotoStorage(repo).download(f"{access['path']}/{'thumb' if thumbnail else 'full'}.jpg")
    # Re-encode on read as well: direct authorized Storage clients cannot inject metadata or non-images.
    full, thumb, _, _ = normalize_photo(raw)
    return Response(thumb if thumbnail else full, media_type='image/jpeg', headers={
        'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="school-photo.jpg"'})


@router.post('/albums/{album_id}/publish')
def publish_album(album_id: UUID, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_album_command', data={'p_album': str(album_id), 'p_action': 'publish', 'p_photo': None})


def cleanup_album(repo, album_id, photo_id=None, retry=False):
    result = repo.request('POST', '/rpc/parents_album_command', data={
        'p_album': str(album_id), 'p_action': 'cleanup' if retry else ('remove_photo' if photo_id else 'withdraw'), 'p_photo': str(photo_id) if photo_id else None})
    # Hide metadata immediately. Failed physical cleanup can be retried without restoring visibility.
    clean = PhotoStorage(repo).delete(result['paths'])
    return {'id': result['id'], 'cleanup_pending': not clean}


@router.delete('/albums/{album_id}')
def withdraw_album(album_id: UUID, user: User, repo: Repo):
    return cleanup_album(repo, album_id)


@router.delete('/albums/{album_id}/photos/{photo_id}')
def remove_photo(album_id: UUID, photo_id: UUID, user: User, repo: Repo):
    return cleanup_album(repo, album_id, photo_id)


@router.get('/gallery/cleanup')
def pending_cleanup(user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_photo_cleanup_list', data={})


@router.post('/albums/{album_id}/cleanup')
def retry_cleanup(album_id: UUID, user: User, repo: Repo):
    return cleanup_album(repo, album_id, retry=True)
