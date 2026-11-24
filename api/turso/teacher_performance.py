"""Owner-only classroom activity and observation history."""
from datetime import datetime, time, timedelta
from zoneinfo import ZoneInfo

from fastapi import HTTPException

from ..auth import mobile_from_login
from .access import forbidden, invalid
from .db import now

OBSERVATION_PAGE_SIZE = 20


def require_owner_center(access, branch_id):
    if 'super_admin' not in access.global_roles:
        forbidden('Teacher performance is available to the school owner.')
    branch = access.branches.get(branch_id)
    if not branch:
        raise HTTPException(404, 'Choose an available center.')
    return branch


def class_assignments(db, branch_id, teacher_id=None):
    where = ' and a.user_id=?' if teacher_id else ''
    args = (branch_id, teacher_id) if teacher_id else (branch_id,)
    return db.all(f'''select distinct a.user_id, c.id, trim(c.name||' '||c.section) name, y.name year_name
        from teacher_assignments a join school_classes c on c.id=a.class_id
        join academic_years y on y.id=c.academic_year_id
        where a.branch_id=? {where} order by name,year_name,c.id''', args)


def options(access, branch_id):
    branch = require_owner_center(access, branch_id)
    db = access.db
    teachers = db.all('''select p.id,p.full_name,a.email
        from profiles p join accounts a on a.id=p.id
        where p.id in (select user_id from user_memberships where branch_id=? and role='teacher'
                       union select user_id from teacher_assignments where branch_id=?)
        order by p.full_name,p.id''', (branch_id, branch_id))
    classes_by_teacher = {}
    for row in class_assignments(db, branch_id):
        teacher = row.pop('user_id')
        classes_by_teacher.setdefault(teacher, []).append(row)
    for teacher in teachers:
        email = teacher.pop('email')
        teacher.update(contact=mobile_from_login(email) or email, classes=classes_by_teacher.get(teacher['id'], []))
    return {'teachers': teachers, 'today': datetime.now(ZoneInfo(branch['timezone'])).date().isoformat()}


def report(access, branch_id, teacher_id, class_id, starts_on, ends_on, page):
    branch = require_owner_center(access, branch_id)
    db = access.db
    if not db.scalar('''select 1 from user_memberships where branch_id=? and user_id=? and role='teacher'
                        union select 1 from teacher_assignments where branch_id=? and user_id=?''',
                     (branch_id, teacher_id, branch_id, teacher_id)):
        invalid('Choose a teacher in this center.')
    classes = {row['id']: row for row in class_assignments(db, branch_id, teacher_id)}
    if class_id and class_id not in classes:
        invalid('Choose a class assigned to this teacher in this center.')
    if class_id:
        classes = {class_id: classes[class_id]}
    days = (starts_on.isoformat(), ends_on.isoformat())
    zone = ZoneInfo(branch['timezone'])
    timestamps = (datetime.combine(starts_on, time.min, zone).isoformat(),
                  datetime.combine(ends_on + timedelta(days=1), time.min, zone).isoformat())

    for classroom in classes.values():
        classroom.pop('user_id')
        classroom.update(days_logged=0, attendance_days=0, care_days=0, diary=0,
                         homework=0, notice=0, event=0, albums=0)

    older_records = False
    for row in db.all('''select coalesce(json_extract(e.metadata,'$.class_id'),s.class_id) class_id,
            count(distinct d.school_day) days_logged,
            count(distinct case when json_extract(e.metadata,'$.attendance') then d.school_day end) attendance_days,
            count(distinct case when json_extract(e.metadata,'$.care') then d.school_day end) care_days,
            max(json_type(e.metadata,'$.attendance') is null) older_records
        from audit_events e join student_daily_records d on d.id=e.entity_id
        join parent_students s on s.id=d.student_id
        where e.branch_id=? and e.actor_user_id=? and e.event_type='teachers.record_shared'
          and e.entity_type='student_daily_records' and d.school_day between ? and ?
        group by 1''', (branch_id, teacher_id, *days)):
        room = classes.get(row.pop('class_id'))
        older = row.pop('older_records')
        if room is not None:
            room.update(row)
            older_records = older_records or bool(older)

    for row in db.all('''select class_id,kind,count(*) total from parent_posts
        where branch_id=? and created_by=? and is_published=1
          and julianday(created_at)>=julianday(?) and julianday(created_at)<julianday(?)
        group by class_id,kind''', (branch_id, teacher_id, *timestamps)):
        if row['class_id'] in classes:
            classes[row['class_id']][row['kind']] = row['total']

    for row in db.all('''select a.class_id,count(distinct a.id) total
        from audit_events e join parent_albums a on a.id=e.entity_id
        where e.branch_id=? and e.actor_user_id=? and e.event_type='parents.album_publish'
          and e.entity_type='parent_album' and a.status='published'
          and julianday(e.occurred_at)>=julianday(?) and julianday(e.occurred_at)<julianday(?)
        group by a.class_id''', (branch_id, teacher_id, *timestamps)):
        if row['class_id'] in classes:
            classes[row['class_id']]['albums'] = row['total']

    where = 'where o.branch_id=? and o.teacher_id=? and o.observed_on between ? and ?'
    args = [branch_id, teacher_id, *days]
    if class_id:
        where += ' and o.class_id=?'
        args.append(class_id)
    observations = db.all('''select o.id,o.class_id,o.observed_on,o.feedback,o.follow_up,p.full_name author_name
        from teacher_observations o join profiles p on p.id=o.created_by '''
        + where + ' order by o.observed_on desc,o.created_at desc,o.id desc limit ? offset ?',
        [*args, OBSERVATION_PAGE_SIZE, (page - 1) * OBSERVATION_PAGE_SIZE])
    return {'classes': list(classes.values()), 'older_records': older_records,
            'observations': observations,
            'total_observations': db.scalar('select count(*) from teacher_observations o ' + where, args),
            'observation_page_size': OBSERVATION_PAGE_SIZE}


def add_observation(access, data):
    branch = require_owner_center(access, data['branch_id'])
    db = access.db
    if not db.scalar('''select 1 from teacher_assignments where branch_id=? and user_id=? and class_id=?''',
                     (branch['id'], data['teacher_id'], data['class_id'])):
        invalid('Choose a class assigned to this teacher in this center.')
    if data['observed_on'] > datetime.now(ZoneInfo(branch['timezone'])).date().isoformat():
        invalid('Choose an observation date on or before today.')
    observation = db.insert('teacher_observations', {**data, 'created_by': access.actor, 'created_at': now()})
    access.audit('school.teacher_observation_added', 'teacher_observation', observation['id'], branch['id'])
    return {'id': observation['id']}
