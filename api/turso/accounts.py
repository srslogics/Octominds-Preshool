"""Password sign-in, rotating sessions, and account setup links."""
import logging
import re
import secrets
from datetime import UTC, datetime
from threading import BoundedSemaphore
from time import time
from typing import Annotated

import httpx
from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from ..auth import (MOBILE_LOGIN_SUFFIX, Credentials, Role, mobile_from_login,
                    mobile_login, normalize_mobile, resolve_account)
from ..config import Settings, get_settings
from .access import Access, forbidden, invalid
from .db import now, token_hash, transaction
from .school import complete_invitation, valid_invitation

router = APIRouter(prefix='/api/v1/auth', tags=['accounts'])
Config = Annotated[Settings, Depends(get_settings)]
hasher = PasswordHasher(time_cost=3, memory_cost=32768, parallelism=2)
dummy_hash = hasher.hash(secrets.token_urlsafe(32))
logger = logging.getLogger(__name__)
password_workers = BoundedSemaphore(4)


def password_valid(email, password):
    return (bool(mobile_from_login(email)) and
            bool(re.fullmatch(r'\d{6}', password))) or 12 <= len(password) <= 128


def verify_password(encoded, password):
    try:
        if encoded.startswith(('$2a$', '$2b$', '$2y$')):
            import bcrypt
            value = password.encode()
            return len(value) <= 72 and bcrypt.checkpw(value, encoded.encode())
        return hasher.verify(encoded, password)
    except (VerificationError, InvalidHashError, ValueError):
        return False


def issue_session(db, user_id):
    access = secrets.token_urlsafe(32)
    refresh = secrets.token_urlsafe(32)
    current = int(time())
    expiry = current + 3600
    db.execute('delete from auth_sessions where user_id=? and refresh_expires_at<=?', (user_id, current))
    db.insert('auth_sessions', {'token_hash': token_hash(access), 'refresh_hash': token_hash(refresh),
        'user_id': user_id, 'expires_at': expiry, 'refresh_expires_at': current+30*86400}, generate_id=False)
    return {'access_token': access, 'refresh_token': refresh, 'expires_at': expiry, 'expires_in': 3600}


def token_account(db, credentials):
    return resolve_account(db, credentials.credentials if credentials else None)


class TokenRequest(BaseModel):
    email: str = Field('', max_length=254)
    password: str = Field('', max_length=128)
    refresh_token: str = Field('', max_length=256)


class EmailRequest(BaseModel):
    email: str = Field(max_length=254)


class Signup(EmailRequest):
    invitation_token: str = Field(pattern=r'^[a-f0-9]{64}$')


class MobileSignup(BaseModel):
    phone: str = Field(max_length=30)
    pin: str = Field(pattern=r'^[0-9]{6}$')
    invitation_token: str = Field(pattern=r'^[a-f0-9]{64}$')


class CodeRequest(BaseModel):
    code: str = Field(min_length=32, max_length=128)


class PasswordChange(BaseModel):
    password: str = Field(min_length=6, max_length=128)
    current_password: str = Field('', max_length=128)


class Reset(CodeRequest):
    password: str = Field(min_length=12, max_length=128)


def signed_in(settings, email, password):
    email = email.strip().lower()
    with transaction(settings) as db:
        candidate = db.one('select * from accounts where email=?', (email,))
    current = int(time())
    if candidate and candidate['locked_until'] > current:
        return None
    encoded = (candidate or {}).get('password_hash')
    if not password_workers.acquire(blocking=False):
        raise HTTPException(429, 'Sign-in is busy. Please try again in a moment.')
    try:
        checked = verify_password(encoded or dummy_hash, password)
        upgraded = hasher.hash(password) if checked and encoded and (
            not encoded.startswith('$argon2') or hasher.check_needs_rehash(encoded)) else None
    finally:
        password_workers.release()
    if not candidate:
        return None
    with transaction(settings,write=True) as db:
        record = db.one("""
            select a.*,p.is_active from accounts a join profiles p on p.id=a.id where a.id=?
            """, (candidate['id'],))
        if (not record or not record['is_active'] or not record['email_confirmed_at'] or
                record['locked_until'] > int(time()) or record['password_hash'] != encoded):
            return None
        if not encoded or not checked:
            failures = record['failed_attempts'] + 1
            db.update('accounts', record['id'], {
                'failed_attempts': 0 if failures >= 5 else failures,
                'locked_until': int(time())+300 if failures >= 5 else 0})
            return None
        values = {'failed_attempts': 0, 'locked_until': 0}
        if upgraded:
            values['password_hash'] = upgraded
        db.update('accounts', record['id'], values)
        return issue_session(db, record['id'])


@router.post('/token')
def exchange(body: TokenRequest, settings: Config, grant_type: str = Query(pattern='^(password|refresh_token)$')):
    if grant_type == 'password':
        result = signed_in(settings, body.email, body.password)
    else:
        with transaction(settings, write=True) as db:
            session = db.one("""
                select s.* from auth_sessions s join profiles p on p.id=s.user_id
                where s.refresh_hash=? and s.refresh_expires_at>? and p.is_active=1
                """, (token_hash(body.refresh_token), int(time())))
            result = None
            if session:
                db.execute('delete from auth_sessions where token_hash=?', (session['token_hash'],))
                result = issue_session(db, session['user_id'])
    if not result:
        raise HTTPException(401, 'Invalid sign-in or expired session. Please try again.')
    return result


@router.post('/logout', status_code=204)
def logout(credentials: Credentials, settings: Config, scope: str = Query('local', pattern='^(local|global)$')):
    with transaction(settings, write=True) as db:
        if scope == 'global':
            account = token_account(db, credentials)
            db.execute('delete from auth_sessions where user_id=?', (account['id'],))
        elif credentials:
            db.execute('delete from auth_sessions where token_hash=?', (token_hash(credentials.credentials),))


def email_enabled(settings):
    return settings.resend_api_key.get_secret_value() and settings.mail_from


def send_email(settings, email, subject, parameter, code):
    link = f"{settings.frontend_origin.rstrip('/')}/school#{parameter}={code}"
    try:
        response = httpx.post('https://api.resend.com/emails', timeout=10,
            headers={'Authorization': f'Bearer {settings.resend_api_key.get_secret_value()}'},
            json={'from': settings.mail_from, 'to': [email], 'subject': subject,
                  'text': f'{subject}\n\n{link}\n\nThis link expires in 30 minutes.'})
        response.raise_for_status()
    except httpx.HTTPError:
        logger.warning('Account email delivery failed')
        raise HTTPException(503, 'Account email is temporarily unavailable. Please try again.')


def email_code(db, user_id, purpose):
    current = int(time())
    latest = db.scalar('select max(expires_at) from auth_recovery where user_id=? and purpose=?', (user_id, purpose))
    if latest and latest>current+1740:
        return None
    db.execute('delete from auth_recovery where user_id=? and purpose=?', (user_id, purpose))
    code = secrets.token_urlsafe(32)
    db.insert('auth_recovery', {'token_hash': token_hash(code), 'user_id': user_id,
        'purpose': purpose, 'expires_at': current+1800}, generate_id=False)
    return code


@router.post('/claim-mobile-invitation')
def claim_mobile_invitation(body: MobileSignup, settings: Config):
    phone = normalize_mobile(body.phone)
    if not phone:
        invalid('Enter a 10-digit Indian mobile number.')
    login = mobile_login(phone)
    if not password_workers.acquire(blocking=False):
        raise HTTPException(429, 'Account setup is busy. Please try again in a moment.')
    try:
        with transaction(settings, write=True) as db:
            invitation = valid_invitation(db, body.invitation_token, login)
            if invitation['role'] != Role.PARENT:
                forbidden('This invitation is invalid or has expired.')
            if db.scalar('select 1 from accounts where email=?', (login,)):
                raise HTTPException(409, 'This number already has an account. Choose “Sign in with an existing PIN” to accept.')
            account = db.insert('accounts', {'email': login, 'password_hash': hasher.hash(body.pin),
                                             'email_confirmed_at': now()})
            db.insert('profiles', {'id': account['id'], 'full_name': invitation['full_name'], 'phone': phone})
            complete_invitation(Access(db, account['id']), invitation)
            return issue_session(db, account['id'])
    finally:
        password_workers.release()


@router.post('/signup')
def signup(body: Signup, settings: Config):
    if not email_enabled(settings):
        raise HTTPException(503, 'Account email has not been configured. Contact your school.')
    email = body.email.strip().lower()
    if email.endswith(MOBILE_LOGIN_SUFFIX):
        invalid('Open your mobile invitation and set up your PIN.')
    with transaction(settings, write=True) as db:
        invitation = valid_invitation(db, body.invitation_token, email)
        account = db.one('select * from accounts where email=?', (email,))
        if account and account['email_confirmed_at']:
            # Existing accounts prove ownership by signing in before accepting.
            return {}
        if not account:
            account = db.insert('accounts', {'email': email})
            db.insert('profiles', {'id': account['id'], 'full_name': invitation['full_name']})
        code = email_code(db, account['id'], 'confirm')
    if code:
        send_email(settings, email, 'Confirm your OctoMinds email and set a password', 'confirm', code)
    return {}


@router.post('/recover')
def recover(body: EmailRequest, settings: Config):
    if not email_enabled(settings):
        raise HTTPException(503, 'Account email has not been configured. Contact your school.')
    email = body.email.strip().lower()
    if email.endswith(MOBILE_LOGIN_SUFFIX):
        return {}
    with transaction(settings, write=True) as db:
        account = db.one("""select a.id from accounts a join profiles p on p.id=a.id
            where email=? and email_confirmed_at is not null and p.is_active=1""", (email,))
        code = email_code(db, account['id'], 'recover') if account else None
    if code:
        send_email(settings, email, 'Reset your OctoMinds password', 'recovery', code)
    return {}


@router.post('/reset')
def reset(body: Reset, settings: Config):
    with transaction(settings, write=True) as db:
        record = db.one("""
            select r.* from auth_recovery r join profiles p on p.id=r.user_id
            where r.token_hash=? and r.expires_at>? and p.is_active=1
            """, (token_hash(body.code), int(time())))
        if not record:
            forbidden('The email link is invalid or expired.')
        values = {'password_hash': hasher.hash(body.password), 'locked_until': 0, 'failed_attempts': 0}
        if record['purpose'] == 'confirm':
            values['email_confirmed_at'] = now()
        db.update('accounts', record['user_id'], values)
        db.execute('delete from auth_recovery where user_id=?', (record['user_id'],))
        db.execute('delete from auth_sessions where user_id=?', (record['user_id'],))
        return issue_session(db, record['user_id'])


@router.put('/user')
def change_password(body: PasswordChange, credentials: Credentials, settings: Config):
    with transaction(settings, write=True) as db:
        account = token_account(db, credentials)
        if not password_valid(account['email'], body.password):
            invalid('Use at least 12 characters, or a six-digit PIN for a mobile sign-in.')
        old = db.scalar('select password_hash from accounts where id=?', (account['id'],))
        if not old or not verify_password(old, body.current_password):
            forbidden('Enter your current password or PIN.')
        db.update('accounts', account['id'], {'password_hash': hasher.hash(body.password)})
        db.execute('delete from auth_sessions where user_id=? and token_hash<>?',
                   (account['id'], token_hash(credentials.credentials)))
        db.execute('delete from auth_recovery where user_id=?', (account['id'],))
    return {}
