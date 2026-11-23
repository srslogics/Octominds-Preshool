"""One explicit transaction per application operation."""
import hashlib
import json
import logging
import re
import sqlite3
from contextlib import contextmanager
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

import libsql
from fastapi import HTTPException

SCHEMA = Path(__file__).with_name('schema.sql')
identifier = re.compile(r'[a-z_][a-z0-9_]*\Z')
logger = logging.getLogger(__name__)

INSERT_TIMESTAMPS = {
    'branches': ('created_at','updated_at'),
    'profiles': ('created_at','updated_at'),
    'user_memberships': ('created_at','updated_at'),
    'audit_events': ('occurred_at',),
    'inventory_categories': ('created_at','updated_at'),
    'inventory_locations': ('created_at','updated_at'),
    'inventory_items': ('created_at','updated_at'),
    'inventory_movements': ('posted_at',),
    'school_invitations': ('created_at',),
    'parent_students': ('created_at','updated_at'),
    'parent_posts': ('created_at',),
    'parent_messages': ('created_at',),
    'parent_albums': ('created_at',),
    'parent_photos': ('created_at',),
}



def now():
    return datetime.now(UTC).isoformat()


def token_hash(token):
    return hashlib.sha256(token.encode()).hexdigest()


def as_dict(cursor, row):
    result = dict(zip((col[0] for col in cursor.description), row, strict=True))
    for key, value in result.items():
        if key in {'is_active', 'is_published', 'singleton'} and value is not None:
            result[key] = bool(value)
        elif key in {'working_days', 'metadata'} and isinstance(value, str):
            result[key] = json.loads(value)
    return result


class Database:
    def __init__(self, connection):
        self.connection = connection

    def execute(self, sql, args=()):
        return self.connection.execute(sql, tuple(args))

    def all(self, sql, args=()):
        cursor = self.execute(sql, args)
        return [as_dict(cursor, row) for row in cursor.fetchall()]

    def one(self, sql, args=()):
        cursor = self.execute(sql, args)
        row = cursor.fetchone()
        return as_dict(cursor, row) if row is not None else None

    def scalar(self, sql, args=()):
        row = self.execute(sql, args).fetchone()
        return row[0] if row is not None else None

    def insert(self, table, values, *, generate_id=True):
        values = dict(values)
        if generate_id:
            values.setdefault('id', str(uuid4()))
        for timestamp in INSERT_TIMESTAMPS.get(table, ()):
            if timestamp not in values:
                values[timestamp] = now()
        columns = list(values)
        if not all(identifier.fullmatch(key) for key in [table, *columns]):
            raise ValueError('Invalid database identifier')
        params = ','.join('?' for _ in columns)
        return self.one(f"insert into {table} ({','.join(columns)}) values ({params}) returning *",
                        [encode(value) for value in values.values()])

    def update(self, table, record_id, values):
        if not values or not all(identifier.fullmatch(key) for key in [table, *values]):
            raise ValueError('Invalid update')
        assignments = ','.join(f'{key}=?' for key in values)
        return self.one(f'update {table} set {assignments} where id=? returning *',
                        [*(encode(value) for value in values.values()), record_id])


def encode(value):
    if isinstance(value, (dict, list)):
        return json.dumps(value, separators=(',', ':'))
    return value


def connect(settings):
    if settings.turso_database_url:
        return libsql.connect(settings.turso_database_url, auth_token=settings.turso_auth_token.get_secret_value(),
                              isolation_level=None, timeout=10)
    file = Path(settings.sqlite_path)
    file.parent.mkdir(parents=True, exist_ok=True)
    return sqlite3.connect(file, isolation_level=None, timeout=10)


def rollback(connection):
    try:
        if connection is not None and connection.in_transaction:
            connection.execute('ROLLBACK')
    except (sqlite3.Error, ValueError):
        logger.warning('Database rollback failed after an interrupted operation')


@contextmanager
def transaction(settings, *, write=False):
    con = None
    try:
        con = connect(settings)
        con.execute('PRAGMA foreign_keys=ON')
        con.execute('BEGIN IMMEDIATE' if write else 'BEGIN')
        yield Database(con)
        con.execute('COMMIT')
    except (sqlite3.Error, ValueError) as exc:
        # libSQL reports remote query failures as ValueError.
        rollback(con)
        message = str(exc).lower()
        if 'unique constraint' in message:
            raise HTTPException(409, 'This record already exists.') from exc
        if 'check constraint' in message or 'foreign key constraint' in message or 'not null constraint' in message:
            raise HTTPException(422, 'Check the required fields and related records.') from exc
        logger.warning('Database operation failed (%s)', type(exc).__name__)
        raise HTTPException(503, 'The database is unavailable. Please retry.') from exc
    except BaseException:
        rollback(con)
        raise
    finally:
        if con is not None:
            con.close()


def initialize(settings):
    # Keep DDL in one transaction. The schema has no embedded statement semicolons.
    with transaction(settings, write=True) as db:
        if db.scalar("select count(*) from sqlite_master where type='table' and name='app_schema'"):
            if db.scalar('select max(version) from app_schema') != 1:
                raise RuntimeError('Unexpected schema version')
            return
        for statement in SCHEMA.read_text().split(';'):
            if statement.strip():
                db.execute(statement)


def ready(settings):
    try:
        with transaction(settings) as db:
            if db.scalar('select max(version) from app_schema') != 1:
                return False
            if settings.environment == 'production':
                return bool(db.scalar('''select 1 from user_memberships m
                    join profiles p on p.id=m.user_id join accounts a on a.id=p.id
                    where m.role='super_admin' and m.is_active=1 and p.is_active=1
                    and a.email_confirmed_at is not null
                    and (m.expires_at is null or julianday(m.expires_at)>julianday('now')) limit 1'''))
            return True
    except HTTPException:
        return False
