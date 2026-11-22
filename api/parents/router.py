"""Parent portal boundaries. Database commands enforce child and class scope too."""
from datetime import date
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import Field, model_validator

from ..auth import CurrentUser, get_current_user
from ..school.router import Fields, SchoolRepository, repository

router = APIRouter(prefix='/api/v1/parents', tags=['parents'])
User = Annotated[CurrentUser, Depends(get_current_user)]
Repo = Annotated[SchoolRepository, Depends(repository)]


class Student(Fields):
    branch_id: UUID
    class_id: UUID
    full_name: str = Field(min_length=1, max_length=120)
    is_active: bool = True
    id: UUID | None = None
    version: int | None = Field(None, ge=1)

    @model_validator(mode='after')
    def edit_version(self):
        if self.id and self.version is None:
            raise ValueError('Reload the child record before editing')
        return self


class Guardian(Fields):
    student_id: UUID
    user_id: UUID
    relationship: str = Field(min_length=1, max_length=40)
    is_active: bool = True


class Post(Fields):
    class_id: UUID
    student_id: UUID | None = None
    kind: Literal['notice', 'homework', 'diary', 'event']
    title: str = Field(min_length=1, max_length=160)
    body: str = Field(min_length=1, max_length=10000)
    event_date: date | None = None

    @model_validator(mode='after')
    def event_has_date(self):
        if self.kind == 'event' and self.event_date is None:
            raise ValueError('Choose a date for this event')
        if self.kind != 'event' and self.event_date is not None:
            raise ValueError('Only calendar events have an event date')
        return self


class Message(Fields):
    body: str = Field(min_length=1, max_length=2000)


@router.get('/workspace')
def workspace(user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_workspace', data={})


@router.get('/children/{student_id}/posts')
def posts(student_id: UUID, user: User, repo: Repo,
          kind: Literal['all', 'notice', 'homework', 'diary', 'event'] = 'all',
          page: int = Query(1, ge=1, le=10000)):
    return repo.request('POST', '/rpc/parents_feed', data={
        'p_student': str(student_id), 'p_kind': kind, 'p_page': page})


@router.get('/children/{student_id}/calendar')
def calendar(student_id: UUID, month: date, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_calendar', data={
        'p_student': str(student_id), 'p_month': month.isoformat()})


@router.get('/children/{student_id}/messages')
def messages(student_id: UUID, user: User, repo: Repo, page: int = Query(1, ge=1, le=10000)):
    return repo.request('POST', '/rpc/parents_thread', data={'p_student': str(student_id), 'p_page': page})


@router.post('/children/{student_id}/messages', status_code=201)
def send_message(student_id: UUID, body: Message, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_send_message', data={
        'p_student': str(student_id), 'p_body': body.body})


@router.post('/students')
def save_student(body: Student, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_save_student', data={'p_data': body.model_dump(mode='json')})


@router.post('/guardians')
def link_guardian(body: Guardian, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_link_guardian', data={'p_data': body.model_dump(mode='json')})


@router.post('/posts', status_code=201)
def publish(body: Post, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_publish', data={'p_data': body.model_dump(mode='json')})


@router.delete('/posts/{post_id}')
def unpublish(post_id: UUID, user: User, repo: Repo):
    return repo.request('POST', '/rpc/parents_unpublish', data={'p_post': str(post_id)})
