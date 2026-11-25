"""Private gallery. Images pass through the API; no public or signed URLs are issued."""
import io
import warnings
from datetime import date
from urllib.parse import unquote
from uuid import UUID

from fastapi import APIRouter, Header, HTTPException, Query, Request, Response
from PIL import Image, ImageOps, UnidentifiedImageError
from starlette.concurrency import run_in_threadpool

from pydantic import Field
from .router import User, Repo
from ..school.router import Fields
from ..turso import photos

router = APIRouter(prefix='/api/v1/parents', tags=['parent-gallery'])
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


@router.get('/children/{student_id}/gallery')
def gallery(student_id: UUID, repo: Repo, page: int = Query(1, ge=1, le=10000)):
    return repo.request('POST', '/rpc/parents_gallery', data={'p_student': str(student_id), 'p_page': page})


@router.get('/gallery/staff')
def staff_albums(repo: Repo, page: int = Query(1, ge=1, le=10000), class_id: UUID | None = None):
    return repo.request('POST', '/rpc/parents_staff_albums', data={'p_page': page, 'p_class': str(class_id) if class_id else None})


@router.get('/albums/{album_id}')
def detail(album_id: UUID, repo: Repo, student_id: UUID | None = None):
    return repo.request('POST', '/rpc/parents_album_detail', data={'p_album': str(album_id), 'p_student': str(student_id) if student_id else None})


@router.post('/albums', status_code=201)
def create_album(body: Album, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_create_album', data={'p_data': body.model_dump(mode='json')})


def process_upload(repo, album_id, photo_id, raw, caption):
    full, thumb, width, height = normalize_photo(raw)
    with repo.access(write=True) as access:
        return photos.upload(access, str(album_id), str(photo_id), full, thumb, width, height, caption)


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
def photo_image(photo_id: UUID, repo: Repo, student_id: UUID | None = None, thumbnail: bool = False):
    with repo.parent_read() as (access, _):
        data = photos.image(access, str(photo_id), str(student_id) if student_id else None, thumbnail)
    return Response(data, media_type='image/jpeg', headers={
        'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline; filename="school-photo.jpg"'})


@router.post('/albums/{album_id}/publish')
def publish_album(album_id: UUID, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_album_command', data={'p_album': str(album_id), 'p_action': 'publish', 'p_photo': None})


@router.delete('/albums/{album_id}')
def withdraw_album(album_id: UUID, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_album_command', data={'p_album': str(album_id), 'p_action': 'withdraw'})


@router.delete('/albums/{album_id}/photos/{photo_id}')
def remove_photo(album_id: UUID, photo_id: UUID, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_album_command', data={
        'p_album': str(album_id), 'p_action': 'remove_photo', 'p_photo': str(photo_id)})
