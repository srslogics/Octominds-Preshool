"""Classroom records shared with linked families."""
import json
from datetime import datetime
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from .access import forbidden
from .db import now

HEALTH_FIELDS = ('allergies', 'diet', 'blood_group')
ATTENDANCE_FIELDS = {'attendance', 'arrival', 'departure'}


def read_record(db, table, where, args):
    row = db.one(f'select id, details, version, updated_at from {table} where {where}', args)
    return unpack(row)


def unpack(row):
    if row:
        row['details'] = json.loads(row['details'])
    return row


def save_record(access, table, existing, identifiers, details, version, branch, *, class_id=None):
    if version != (existing['version'] if existing else None):
        raise HTTPException(409, 'This record changed. Reload it before saving.')
    values = {'details': details, 'updated_at': now()}
    if existing:
        row = access.db.update(table, existing['id'], {**values, 'version': version + 1})
    else:
        row = access.db.insert(table, {**values, **identifiers})
    metadata = None
    if table == 'student_daily_records':
        previous = existing['details'] if existing else {}
        entered = {field for field, value in details.items() if value and value != previous.get(field)}
        metadata = {'class_id': class_id, 'attendance': bool(entered & ATTENDANCE_FIELDS),
                    'care': bool(entered - ATTENDANCE_FIELDS)}
    access.audit('teachers.record_shared', table, row['id'], branch, metadata)
    return unpack(row)


def daily(db, student_id, day):
    return read_record(db, 'student_daily_records', 'student_id=? and school_day=?', (student_id, day))


def meals(db, class_id, day):
    return read_record(db, 'class_meal_plans', 'class_id=? and school_day=?', (class_id, day))


def profile(db, student_id):
    return read_record(db, 'student_family_profiles', 'student_id=?', (student_id,))


def school_day(access, child):
    zone = ZoneInfo(access.branches[child['branch_id']]['timezone'])
    return datetime.now(zone).date().isoformat()


def today(access, child):
    day = school_day(access, child)
    return {'day': day, 'daily': daily(access.db, child['id'], day), 'meals': meals(access.db, child['class_id'], day)}


def diary(access, child, page):
    rows = access.db.all('''select school_day,details from student_daily_records where student_id=?
        order by school_day desc limit 20 offset ?''', (child['id'], (page - 1) * 20))
    return {'entries': [unpack(row) for row in rows],
            'total': access.db.scalar('select count(*) from student_daily_records where student_id=?', (child['id'],))}


def require_class(access, class_id):
    if not access.teach(class_id):
        forbidden('Access is limited to the classes you teach or manage.')
    return access.class_open(class_id)


def require_student(access, student_id):
    student = access.db.one('select id,class_id,branch_id from parent_students where id=? and is_active=1', (student_id,))
    if not student or not access.teach(student['class_id']):
        forbidden('Choose a student in a class you teach or manage.')
    return student


def classroom_posts(access, class_id, kind, page):
    require_class(access, class_id)
    where = 'where p.class_id=? and p.is_published=1'
    args = [class_id]
    if kind == 'circulars':
        where += " and p.kind in ('notice', 'event')"
    else:
        where += ' and p.kind=?'
        args.append(kind)
    rows = access.db.all('''select p.id,p.title,p.body,p.kind,p.event_date,p.created_at,p.created_by,p.branch_id,
        s.full_name student_name, a.full_name author_name from parent_posts p
        join profiles a on a.id=p.created_by left join parent_students s on s.id=p.student_id '''
        + where + ' order by p.created_at desc,p.id desc limit 20 offset ?', [*args, (page - 1) * 20])
    for row in rows:
        author, branch = row.pop('created_by'), row.pop('branch_id')
        row['can_withdraw'] = author == access.actor or access.manage(branch)
    return {'posts': rows, 'total': access.db.scalar('select count(*) from parent_posts p ' + where, args),
            'page_size': 20}
