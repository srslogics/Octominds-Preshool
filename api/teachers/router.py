from datetime import date
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Query
from pydantic import Field, model_validator

from ..parents.router import Repo, User
from ..school.router import Fields
from ..turso import families, teaching
from ..turso.access import forbidden

router = APIRouter(prefix='/api/v1/teachers', tags=['teachers'])


class Versioned(Fields):
    version: int | None = Field(None, ge=1)


class Daily(Versioned):
    attendance: Literal['', 'present', 'absent', 'late'] = ''
    arrival: str = Field('', pattern=r'^$|^(?:[01]\d|2[0-3]):[0-5]\d$')
    departure: str = Field('', pattern=r'^$|^(?:[01]\d|2[0-3]):[0-5]\d$')
    mood: str = Field('', max_length=200)
    lunch: str = Field('', max_length=400)
    rest: str = Field('', max_length=400)
    water: str = Field('', max_length=200)
    toilet: str = Field('', max_length=200)
    pickup_note: str = Field('', max_length=400)
    note: str = Field('', max_length=1000)

    @model_validator(mode='after')
    def valid_attendance(self):
        if self.attendance not in ('present', 'late') and (self.arrival or self.departure):
            raise ValueError('Choose Present or Late before entering attendance times.')
        if self.departure and (not self.arrival or self.departure < self.arrival):
            raise ValueError('Departure needs an arrival time and must be at or after arrival.')
        return self


class Menu(Versioned):
    breakfast: str = Field('', max_length=400)
    lunch: str = Field('', max_length=400)
    snack: str = Field('', max_length=400)


class FamilyProfile(Versioned):
    nickname: str = Field('', max_length=80)
    cubby: str = Field('', max_length=40)
    nap: str = Field('', max_length=400)
    milestones: str = Field('', max_length=1000)
    allergies: str = Field('', max_length=400)
    diet: str = Field('', max_length=400)
    blood_group: Literal['', 'A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] = ''


@router.get('/workspace')
def workspace(user: User, repo: Repo):
    with repo.access() as access:
        if not access.global_roles and not any(roles & {'teacher', 'branch_admin'} for roles in access.roles.values()):
            forbidden('This app is for teachers and school administrators.')
        return {**families.workspace(access, p_staff_only=True), 'account': user.session_details()}


@router.get('/classes/{class_id}/posts')
def posts(class_id: UUID, user: User, repo: Repo,
          kind: Literal['circulars', 'homework', 'diary', 'event'], page: int = Query(1, ge=1, le=10000)):
    with repo.access() as access:
        return teaching.classroom_posts(access, str(class_id), kind, page)


@router.get('/children/{student_id}/daily/{day}')
def daily(student_id: UUID, day: date, user: User, repo: Repo):
    with repo.access() as access:
        child = teaching.require_student(access, str(student_id))
        return teaching.daily(access.db, child['id'], day.isoformat())


@router.put('/children/{student_id}/daily/{day}')
def save_daily(student_id: UUID, day: date, body: Daily, user: User, repo: Repo):
    with repo.access(write=True) as access:
        child = teaching.require_student(access, str(student_id))
        ident = {'student_id': child['id'], 'school_day': day.isoformat()}
        existing = teaching.daily(access.db, child['id'], day.isoformat())
        return teaching.save_record(access, 'student_daily_records', existing, ident,
                                    body.model_dump(exclude={'version'}), body.version, child['branch_id'],
                                    class_id=child['class_id'])


@router.get('/classes/{class_id}/menu/{day}')
def menu(class_id: UUID, day: date, user: User, repo: Repo):
    with repo.access() as access:
        classroom = teaching.require_class(access, str(class_id))
        return teaching.meals(access.db, classroom['id'], day.isoformat())


@router.put('/classes/{class_id}/menu/{day}')
def save_menu(class_id: UUID, day: date, body: Menu, user: User, repo: Repo):
    with repo.access(write=True) as access:
        classroom = teaching.require_class(access, str(class_id))
        ident = {'class_id': classroom['id'], 'school_day': day.isoformat()}
        existing = teaching.meals(access.db, classroom['id'], day.isoformat())
        return teaching.save_record(access, 'class_meal_plans', existing, ident,
                                    body.model_dump(exclude={'version'}), body.version, classroom['branch_id'])


@router.get('/children/{student_id}/profile')
def profile(student_id: UUID, user: User, repo: Repo):
    with repo.access() as access:
        child = teaching.require_student(access, str(student_id))
        return teaching.profile(access.db, child['id'])


@router.put('/children/{student_id}/profile')
def save_profile(student_id: UUID, body: FamilyProfile, user: User, repo: Repo):
    with repo.access(write=True) as access:
        child = teaching.require_student(access, str(student_id))
        existing = teaching.profile(access.db, child['id'])
        previous = existing['details'] if existing else {}
        changes = body.model_dump(exclude={'version'}, exclude_unset=True)
        if not access.manage(child['branch_id']) and any(
                field in changes and changes[field] != previous.get(field, '') for field in teaching.HEALTH_FIELDS):
            forbidden('A center administrator can update the health and diet details.')
        return teaching.save_record(access, 'student_family_profiles', existing, {'student_id': child['id']},
                                    {**previous, **changes}, body.version, child['branch_id'])
