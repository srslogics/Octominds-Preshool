from datetime import date, datetime, time
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator

from ..auth import MOBILE_LOGIN_SUFFIX, CurrentUser, Role, bearer, get_current_user, normalize_mobile
from ..config import Settings, get_settings
from ..turso.repository import SchoolRepository

router = APIRouter(prefix='/api/v1/school', tags=['school'])


class Fields(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class School(Fields):
    name: str = Field(min_length=1, max_length=120)
    email: str | None = Field(None, max_length=254)
    phone: str | None = Field(None, max_length=30)
    address: str | None = Field(None, max_length=500)
    website: str | None = Field(None, max_length=500)


class Center(School):
    website: None = None
    code: str = Field(min_length=1, max_length=20, pattern=r'^[A-Za-z0-9_-]+$')
    timezone: str = 'Asia/Kolkata'
    opens_at: time | None = None
    closes_at: time | None = None
    working_days: list[int] = Field(default_factory=lambda: [1, 2, 3, 4, 5], max_length=7)
    capacity: int | None = Field(None, ge=0, le=100000)
    is_active: bool = True

    @field_validator('timezone')
    @classmethod
    def timezone_exists(cls, value):
        try:
            ZoneInfo(value)
        except ZoneInfoNotFoundError as exc:
            raise ValueError('Enter a valid timezone') from exc
        return value

    @field_validator('working_days')
    @classmethod
    def valid_days(cls, value):
        if len(set(value)) != len(value) or any(day not in range(7) for day in value):
            raise ValueError('Choose each working day at most once')
        return value


class Scoped(Fields):
    branch_id: UUID


class Year(Scoped):
    name: str = Field(min_length=1, max_length=120)
    starts_on: date
    ends_on: date
    status: Literal['planned', 'active', 'closed'] = 'planned'


class Term(Scoped):
    academic_year_id: UUID
    name: str = Field(min_length=1, max_length=120)
    starts_on: date
    ends_on: date


class Program(Scoped):
    name: str = Field(min_length=1, max_length=120)
    description: str | None = Field(None, max_length=1000)
    is_active: bool = True


class SchoolClass(Scoped):
    academic_year_id: UUID
    program_id: UUID
    name: str = Field(min_length=1, max_length=120)
    section: str = Field('', max_length=30)
    room: str | None = Field(None, max_length=80)
    capacity: int = Field(ge=1, le=1000)
    is_active: bool = True


class Assignment(Scoped):
    class_id: UUID
    user_id: UUID
    starts_on: date
    ends_on: date | None = None
    is_active: bool = True


class Holiday(Scoped):
    name: str = Field(min_length=1, max_length=120)
    starts_on: date
    ends_on: date
    is_active: bool = True


class SaveRecord(Fields):
    id: UUID | None = None
    version: int | None = Field(None, ge=1)
    data: dict


class Recipient(Fields):
    email: str | None = Field(None, min_length=3, max_length=254, pattern=r'^[^\s@]+@[^\s@]+\.[^\s@]+$')
    phone: str | None = Field(None, max_length=30)
    full_name: str = Field(min_length=1, max_length=120)

    @model_validator(mode='after')
    def validate_recipient(self):
        if (self.email is None) == (self.phone is None):
            raise ValueError('Enter either an email address or a mobile number.')
        if self.phone is not None:
            self.phone = normalize_mobile(self.phone)
            if self.phone is None:
                raise ValueError('Enter a 10-digit Indian mobile number.')
        if self.email and self.email.lower().endswith(MOBILE_LOGIN_SUFFIX):
            raise ValueError('Use the mobile number option for this account.')
        return self


class EnrollmentGuardian(Recipient):
    relationship: str = Field(min_length=1, max_length=40)


class StudentAccess(Fields):
    role: Role
    branch_id: UUID | None = None
    expires_at: datetime | None = None
    student_id: UUID | None = None
    relationship: str | None = Field(None, min_length=1, max_length=40)

    @model_validator(mode='after')
    def validate_student(self):
        if self.student_id and self.role != Role.PARENT:
            raise ValueError('Only parent or guardian access can be linked to a student.')
        if bool(self.student_id) != bool(self.relationship):
            raise ValueError('Choose a student and enter the parent’s relationship.')
        return self


class Invitation(Recipient, StudentAccess):
    @model_validator(mode='after')
    def validate_mobile_role(self):
        if self.phone and self.role != Role.PARENT:
            raise ValueError('Mobile invitations are available for parents and guardians.')
        return self


class Grant(StudentAccess):
    user_id: UUID


class RecordID(Fields):
    id: UUID


class AccountStatus(Fields):
    user_id: UUID
    is_active: bool


class AcceptInvitation(Fields):
    token: str = Field(min_length=64, max_length=64, pattern=r'^[0-9a-f]+$')


MODELS = {'school': School, 'centers': Center, 'years': Year, 'terms': Term,
          'programs': Program, 'classes': SchoolClass, 'assignments': Assignment, 'holidays': Holiday}
ACTIONS = {'invite': Invitation, 'grant': Grant, 'revoke': RecordID,
           'revoke_invite': RecordID, 'status': AccountStatus}


def repository(credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
               settings: Annotated[Settings, Depends(get_settings)]):
    if not credentials:
        raise HTTPException(401, 'Authentication required')
    return SchoolRepository(settings, credentials.credentials)


def validate(model, data):
    try:
        return model.model_validate(data).model_dump(mode='json')
    except ValidationError as exc:
        raise HTTPException(422, '; '.join(e['msg'] for e in exc.errors())) from exc


@router.get('/workspace')
def workspace(user: Annotated[CurrentUser, Depends(get_current_user)],
              repo: Annotated[SchoolRepository, Depends(repository)]):
    return repo.request('POST', '/rpc/school_workspace', data={})


@router.post('/records/{kind}')
def save_record(kind: str, body: SaveRecord, user: Annotated[CurrentUser, Depends(get_current_user)],
                repo: Annotated[SchoolRepository, Depends(repository)]):
    if kind not in MODELS:
        raise HTTPException(404, 'Unknown school record')
    if body.id is not None and body.version is None:
        raise HTTPException(422, 'Reload the record before editing')
    data = validate(MODELS[kind], body.data)
    if kind == 'centers':
        data.pop('website', None)
        data['code'] = data['code'].upper()
        # Center admins may update details but only management changes status.
        if user.role not in {Role.SUPER_ADMIN, Role.MANAGEMENT}:
            if not data['is_active']:
                raise HTTPException(403, 'Only management can archive centers')
            data.pop('is_active')
    return repo.request('POST', '/rpc/school_save_record', data={
        'p_kind': kind, 'p_data': data, 'p_id': str(body.id) if body.id else None, 'p_version': body.version})


@router.get('/access')
def access(user: Annotated[CurrentUser, Depends(get_current_user)],
           repo: Annotated[SchoolRepository, Depends(repository)]):
    if user.role not in {Role.SUPER_ADMIN, Role.MANAGEMENT, Role.BRANCH_ADMIN}:
        raise HTTPException(403, 'Administration access required')
    return repo.request('POST', '/rpc/school_access_directory', data={})


@router.post('/access/{action}')
def access_command(action: str, body: dict, user: Annotated[CurrentUser, Depends(get_current_user)],
                   repo: Annotated[SchoolRepository, Depends(repository)]):
    if action not in ACTIONS:
        raise HTTPException(404, 'Unknown account action')
    data = validate(ACTIONS[action], body)
    return repo.request('POST', '/rpc/school_access_command', data={'p_action': action, 'p_data': data})


@router.post('/accept-invitation')
def accept_invitation(body: AcceptInvitation, repo: Annotated[SchoolRepository, Depends(repository)]):
    # Deliberately does not require a membership: invitees do not have one yet.
    # The repository verifies the session and matches the account to the invitation.
    return repo.request('POST', '/rpc/school_accept_invitation', data={'p_token': body.token})
