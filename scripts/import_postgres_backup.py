"""Build a verified SQLite snapshot from a restored, read-only PostgreSQL backup."""
import argparse
import hashlib
import json
import os
import sqlite3
import tempfile
from contextlib import closing
from datetime import UTC, date, datetime, time
from decimal import Decimal
from pathlib import Path
from uuid import UUID

import psycopg2
from psycopg2 import sql
from psycopg2.extras import RealDictCursor, register_uuid

from api.inventory.repository import SCALES
from api.parents.gallery import MAX_UPLOAD, normalize_photo
from api.turso.db import SCHEMA

TABLES = (
    'branches', 'profiles', 'user_memberships', 'audit_events',
    'inventory_categories', 'inventory_locations', 'inventory_items', 'inventory_stock_balances', 'inventory_movements',
    'school_settings', 'academic_years', 'school_terms', 'school_programs', 'school_classes',
    'teacher_assignments', 'school_holidays', 'school_invitations',
    'parent_students', 'parent_guardians', 'parent_posts', 'parent_messages', 'parent_albums', 'parent_photos',
)
OPTIONAL = frozenset(t for t in TABLES if t.startswith('parent_'))


def normalize(key, value):
    if value is None:
        return None
    if key in SCALES:
        units = Decimal(value) * SCALES[key]
        if not units.is_finite() or units != units.to_integral_value() or abs(units) >= 10**14:
            raise ValueError(f'Unrepresentable stock number in {key}')
        return int(units)
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    if isinstance(value, (date, time)):
        return value.isoformat()
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, memoryview):
        return value.hex()
    if isinstance(value, (list, dict)):
        return json.dumps(value,separators=(',', ':'))
    return value


def add(target, table, values):
    columns = tuple(values)
    placeholders = ','.join('?' for _ in columns)
    target.execute(f"insert into {table} ({','.join(columns)}) values ({placeholders})", tuple(values.values()))


def accounts(source, target):
    with source.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute('''
            select u.id,u.email,u.phone,u.encrypted_password,u.email_confirmed_at
            from auth.users u join public.profiles p on p.id=u.id order by u.id
        ''')
        reset_count = 0
        for row in cursor:
            email = (row['email'] or '').strip().lower()
            if not email:
                raise ValueError('An account has no stored sign-in email. Map it to a verified address before importing.')
            password = row['encrypted_password'] or None
            if password and not password.startswith(('$2a$', '$2b$', '$2y$', '$argon2')):
                raise ValueError('An account has an unsupported password hash. Arrange a reset before importing.')
            reset_count += password is None
            add(target, 'accounts', {'id':str(row['id']),'email':email,'password_hash':password,
                'email_confirmed_at':normalize('email_confirmed_at',row['email_confirmed_at'])})
    return reset_count


def public_records(source, target):
    counts = {}
    with source.cursor(cursor_factory=RealDictCursor) as cursor:
        for table in TABLES:
            cursor.execute('select to_regclass(%s) as table_name', (f'public.{table}',))
            if cursor.fetchone()['table_name'] is None:
                if table not in OPTIONAL:
                    raise ValueError(f'Required source table is missing: {table}')
                counts[table] = 0
                continue
            target_columns = {r[1] for r in target.execute(f'pragma table_info({table})')}
            cursor.execute(sql.SQL('select * from public.{}').format(sql.Identifier(table)))
            counts[table] = 0
            for row in cursor:
                values = {k: normalize(k,v) for k,v in row.items() if k in target_columns}
                add(target, table, values)
                counts[table] += 1
    return counts


def command_history(target):
    movements = target.execute('''select * from inventory_movements where idempotency_key is not null
                                  and movement_type<>'transfer_in' ''')
    for row in movements:
        operation = 'transfer' if row['movement_type']=='transfer_out' else 'movement'
        key = row['idempotency_key']
        payload = {k:row[k] for k in ('branch_id','item_id','quantity','reference','notes')}
        if operation=='transfer':
            incoming=target.execute("""select location_id,quantity_after from inventory_movements where transfer_group_id=?
                                        and movement_type='transfer_in'""",(row['transfer_group_id'],)).fetchall()
            if len(incoming)!=1 or not key.endswith(':out'):
                raise ValueError('A transfer retry record has no matching movement.')
            key=key.removesuffix(':out')
            payload.update(from_location_id=row['location_id'],to_location_id=incoming[0]['location_id'])
            result={'transfer_group_id':row['transfer_group_id'],'from_quantity_after':row['quantity_after']/1000,
                    'to_quantity_after':incoming[0]['quantity_after']/1000}
        else:
            payload.update(location_id=row['location_id'],movement_type=row['movement_type'],unit_cost=row['unit_cost'])
            result={'movement_id':row['id'],'quantity_after':row['quantity_after']/1000}
        add(target,'inventory_commands',{'actor_id':row['posted_by'],'command_key':key,'operation':operation,
            'payload':json.dumps(payload,sort_keys=True,separators=(',',':')),'result':json.dumps(result)})


def photos(target, root):
    imported = 0
    for row in target.execute("""select p.id,p.album_id,p.status from parent_photos p join parent_albums a on a.id=p.album_id
                                 where p.status<>'removed' and a.status<>'withdrawn'"""):
        if row['status']=='pending':
            # Incomplete old uploads have no guaranteed object pair and stay unpublished.
            continue
        album, photo = UUID(row['album_id']), UUID(row['id'])
        path = root / str(album) / str(photo) / 'full.jpg' if root else None
        if path is None or not path.is_file() or path.stat().st_size>MAX_UPLOAD:
            raise ValueError(f'Missing or oversized photo in the Storage backup: {album}/{photo}/full.jpg')
        full,thumb,w,h=normalize_photo(path.read_bytes())
        target.execute('update parent_photos set checksum=?,width=?,height=? where id=?',
                       (hashlib.sha256(full).hexdigest(),w,h,str(photo)))
        for variant,image in (('full',full),('thumb',thumb)):
            target.executemany('insert into photo_chunks values (?,?,?,?)',
                [(str(photo),variant,i//65536,image[i:i+65536]) for i in range(0,len(image),65536)])
        imported+=1
    return imported


def prepare(dsn, snapshot, objects=None):
    snapshot=Path(snapshot)
    if snapshot.exists():
        raise ValueError('Choose a new snapshot path.')
    snapshot.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(dir=snapshot.parent) as work:
        staging=Path(work)/'octominds.db'
        with closing(psycopg2.connect(dsn)) as source, closing(sqlite3.connect(staging)) as target:
            register_uuid(conn_or_curs=source)
            source.set_session(readonly=True,isolation_level='REPEATABLE READ')
            target.row_factory=sqlite3.Row
            target.executescript(SCHEMA.read_text())
            target.execute('pragma foreign_keys=on')
            target.execute('begin')
            target.execute('pragma defer_foreign_keys=on')
            resets=accounts(source,target)
            counts=public_records(source,target)
            command_history(target)
            photo_count=photos(target, Path(objects) if objects else None)
            if target.execute('pragma foreign_key_check').fetchone():
                raise ValueError('A source row refers to missing data. The snapshot was discarded.')
            if target.execute('pragma integrity_check').fetchone()[0]!='ok':
                raise ValueError('The prepared database failed integrity checks.')
            target.commit()
        staging.chmod(0o600)
        # Expose only a complete snapshot and never replace an existing destination.
        os.link(staging,snapshot)
    return {'table_counts':counts,'accounts_without_password':resets,'photos_imported':photo_count}


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('snapshot',type=Path)
    parser.add_argument('--objects',type=Path,help='Local export of the octominds-parent-photos bucket')
    args=parser.parse_args()
    dsn=os.environ.get('OCTOMINDS_BACKUP_DATABASE_URL')
    if not dsn:
        parser.error('Set OCTOMINDS_BACKUP_DATABASE_URL to a restored PostgreSQL backup.')
    try:
        print(json.dumps(prepare(dsn,args.snapshot,args.objects),indent=2))
    except (sqlite3.Error, psycopg2.Error) as exc:
        # PostgreSQL error details may contain addresses, secrets, or student data.
        raise SystemExit(f'Backup import failed ({type(exc).__name__}). No snapshot was written.') from None


if __name__=='__main__':
    main()
