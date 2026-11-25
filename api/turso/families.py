"""Family portal records and scoped class communication."""
from fastapi import HTTPException

from ..auth import mobile_from_login, mobile_login
from . import teaching
from .access import forbidden, invalid
from .db import now


def require_child(access, student_id):
    child = access.db.one('select * from parent_students where id=?', (student_id,))
    if not access.child(child):
        forbidden('Child access is not assigned.')
    return child


def scoped_children(access, class_id=None):
    sql = '''select s.*,b.name center_name,trim(c.name||' '||c.section) class_name,y.name year_name
       from parent_students s join branches b on b.id=s.branch_id
       join school_classes c on c.id=s.class_id join academic_years y on y.id=c.academic_year_id'''
    clauses, params = [], []
    for column, ids in [('s.branch_id',access.managed_branches), ('s.class_id',access.class_ids),
                        ('s.id',access.guardian_links.keys())]:
        if ids:
            clauses.append(f"{column} in ({','.join('?' for _ in ids)})")
            params.extend(ids)
    if not clauses:
        return []
    where = '('+' or '.join(clauses)+')'
    if class_id:
        where += ' and c.id=?'
        params.append(class_id)
    rows = access.db.all(sql+' where '+where+' order by s.full_name,s.id',params)
    return [row for row in rows if access.child(row)]



def workspace(access, p_today_month=None, p_staff_only=False):
    db = access.db
    classes = []
    if access.class_ids:
        slots = ','.join('?' for _ in access.class_ids)
        classes = db.all(f"""select c.id,c.branch_id,trim(c.name||' '||c.section) name,b.name center_name,y.name year_name,b.timezone
            from school_classes c join branches b on b.id=c.branch_id join academic_years y on y.id=c.academic_year_id
            where c.id in ({slots}) order by b.name,c.name,c.section""", access.class_ids)
        for classroom in classes:
            classroom['can_manage'] = access.manage(classroom['branch_id'])
    students = scoped_children(access)
    if p_staff_only:
        students = [student for student in students if access.teach(student['class_id']) and student['is_active']]
    for child in students:
        child.update(can_manage=access.manage(child['branch_id']), can_publish=access.teach(child['class_id']),
                     relationship=access.guardian_links.get(child['id']))
    guardians, accounts = [], []
    if not p_staff_only and access.managed_branches:
        slots = ','.join('?' for _ in access.managed_branches)
        guardians = db.all(f"""select g.* from parent_guardians g join parent_students s on s.id=g.student_id
                               where s.branch_id in ({slots})""", access.managed_branches)
        accounts = db.all(f"""select p.id user_id,m.branch_id,p.full_name,a.email from profiles p
            join accounts a on a.id=p.id join user_memberships m on m.user_id=p.id
            where m.branch_id in ({slots}) and p.is_active=1 and a.email_confirmed_at is not null
            and m.is_active=1 and m.role='parent'
            and (m.expires_at is null or julianday(m.expires_at)>julianday('now')) order by p.full_name""",
            access.managed_branches)
    result = {'classes': classes, 'students': students, 'guardians': guardians,
              'parent_accounts': [{**a, 'phone': mobile_from_login(a['email'])} for a in accounts]}
    if p_today_month and students:
        child = next((student for student in students if student['is_active']), students[0])
        result['today'] = today_summary(access, child, p_today_month)
    return result


def today_summary(access, child, month, *, post_limit=3):
    return {
        'student_id': child['id'], 'month': month,
        'posts': recent_posts(access, child, limit=post_limit),
        'calendar': child_calendar(access.db, child, month),
        'care': teaching.today(access, child),
    }


def today(access, p_student, p_month):
    return today_summary(access, require_child(access, p_student), p_month, post_limit=20)


def child_profile(access, p_student):
    child = require_child(access, p_student)
    teachers = access.db.all("""
        select distinct p.full_name
        from teacher_assignments t join profiles p on p.id=t.user_id
        where t.class_id=? and p.is_active=1 and t.is_active=1
          and t.starts_on<=date('now') and (t.ends_on is null or t.ends_on>=date('now'))
          and exists (
              select 1 from user_memberships m
              where m.user_id=t.user_id and m.branch_id=t.branch_id and m.role='teacher' and m.is_active=1
                and (m.expires_at is null or julianday(m.expires_at)>julianday('now'))
          )
        order by p.full_name
        """, (child['class_id'],)) if access.class_open(child['class_id']) else []
    family_profile = teaching.profile(access.db, child['id'])
    return {'team': [{**teacher, 'role': 'Class teacher'} for teacher in teachers],
            'office_phone': access.branches[child['branch_id']]['phone'],
            'family_profile': family_profile['details'] if family_profile else {},
            'attendance': teaching.daily(access.db, child['id'], teaching.school_day(access, child))}


def enrollment_students(access):
    branches = [branch for branch in access.managed_branches if access.active(branch)]
    if not branches:
        return []
    placeholders = ','.join('?' for _ in branches)
    students = access.db.all(f"""
        select s.id, s.full_name, s.branch_id, s.class_id,
               g.full_name guardian_name, g.login guardian_login, g.relationship
        from parent_students s join school_classes c on c.id=s.class_id
        join academic_years y on y.id=c.academic_year_id
        left join student_guardian_contacts g on g.student_id=s.id
        where s.branch_id in ({placeholders}) and s.is_active=1 and c.is_active=1 and y.status<>'closed'
        order by s.full_name, s.id
        """, branches)
    for student in students:
        login = student.pop('guardian_login')
        name = student.pop('guardian_name')
        relationship = student.pop('relationship')
        phone = mobile_from_login(login) if login else None
        student['guardian'] = ({'full_name': name, 'phone': phone, 'email': None if phone else login,
                                'relationship': relationship} if login else None)
    return students


def require_enrollment_student(access, student_id, branch):
    child = access.db.one('select * from parent_students where id=? and branch_id=? and is_active=1',
                          (student_id, branch))
    if not access.manage(branch) or not child or not access.class_open(child['class_id']):
        invalid('Choose an active student in this center.')
    return child


def save_guardian_contact(db, student_id, guardian, *, replace=False):
    phone = guardian.get('phone')
    login = mobile_login(phone) if phone else guardian['email'].lower()
    db.execute('''insert into student_guardian_contacts (student_id,full_name,login,relationship)
                  values (?,?,?,?)
                  on conflict(student_id) do update set full_name=excluded.full_name,
                      login=excluded.login,relationship=excluded.relationship where ?''',
               (student_id, guardian['full_name'], login, guardian['relationship'], replace))


def save_student(access, p_data):
    data = dict(p_data)
    ident, version = data.pop('id'), data.pop('version')
    guardian = data.pop('guardian', None)
    db = access.db
    branch = data['branch_id']
    if not access.manage(branch):
        forbidden('Center administration access required.')
    classroom = access.class_open(data['class_id'])
    if not classroom or classroom['branch_id'] != branch:
        invalid('Choose an active class in an open year at this center.')
    if ident:
        child = require_child(access, ident)
        if child['branch_id'] != branch or child['class_id'] != data['class_id']:
            invalid('Class transfers require a separate enrollment workflow.')
        if version != child['version']:
            raise HTTPException(409, 'This record changed. Reload before saving.')
        result = db.update('parent_students', ident, {**data, 'version': version+1, 'updated_at': now()})
    else:
        result = db.insert('parent_students', data)
    if guardian:
        save_guardian_contact(db, result['id'], guardian, replace=True)
    access.audit('parents.student_saved', 'student', result['id'], branch)
    return result


def link_guardian(access, p_data):
    db = access.db
    child = require_child(access, p_data['student_id'])
    branch = child['branch_id']
    if not access.manage(branch):
        forbidden('Center administration access required.')
    parent = p_data['user_id']
    if p_data['is_active'] and (not child['is_active'] or 'parent' not in
            type(access)(db, parent).roles.get(branch, set()) or not db.scalar(
                'select 1 from accounts where id=? and email_confirmed_at is not null', (parent,))):
        invalid('Choose an active, verified parent account in this center.')
    old = db.one('select id from parent_guardians where student_id=? and user_id=?', (child['id'], parent))
    result = db.update('parent_guardians', old['id'], p_data) if old else db.insert('parent_guardians', p_data)
    if not p_data['is_active']:
        db.execute('''update school_invitations set revoked_at=?
                      where accepted_at is null and revoked_at is null
                        and email=(select email from accounts where id=?)
                        and id in (select invitation_id from school_invitation_students where student_id=?)''',
                   (now(), parent, child['id']))
    access.audit('parents.guardian_linked', 'guardian', result['id'], branch)
    return result


def publish_target(access, data):
    classroom = access.class_open(data['class_id'])
    if not classroom or not access.teach(classroom['id']):
        forbidden('Assigned teacher or center administration access required.')
    student = data.get('student_id')
    if student and not access.db.scalar('select 1 from parent_students where id=? and class_id=? and is_active=1',
                                         (student, classroom['id'])):
        invalid('Choose a child in this class.')
    return classroom


def publish(access, p_data):
    classroom = publish_target(access, p_data)
    post = access.db.insert('parent_posts', {**p_data, 'branch_id': classroom['branch_id'], 'created_by': access.actor})
    access.audit('parents.post_published', 'parent_post', post['id'], classroom['branch_id'])
    return post


def can_edit_post(access, post):
    return access.teach(post['class_id']) and (post['created_by'] == access.actor or access.manage(post['branch_id']))


def unpublish(access, p_post):
    post = access.db.one('select * from parent_posts where id=?', (p_post,))
    if not post or not can_edit_post(access, post):
        forbidden('You cannot withdraw this update.')
    access.db.update('parent_posts', p_post, {'is_published': False})
    access.audit('parents.post_withdrawn', 'parent_post', p_post, post['branch_id'])
    return {'id': p_post}


def feed(access, p_student, p_kind='all', p_page=1):
    child = require_child(access, p_student)
    posts, total = recent_posts(access, child, p_kind, 20, (p_page - 1) * 20, include_total=True)
    result = {'posts': posts, 'total': total, 'page': p_page, 'page_size': 20}
    if p_kind == 'diary':
        result['routine'] = teaching.diary(access, child, p_page)
    return result


def recent_posts(access, child, kind='all', limit=20, offset=0, *, include_total=False):
    clause = 'where p.is_published=1 and p.class_id=? and (p.student_id is null or p.student_id=?)'
    args = [child['class_id'], child['id']]
    if kind == 'circulars':
        clause += " and p.kind in ('notice', 'event')"
    elif kind != 'all':
        clause += ' and p.kind=?'
        args.append(kind)
    rows = access.db.all('''select p.*,a.full_name author_name from parent_posts p join profiles a on a.id=p.created_by '''
                         +clause+' order by p.created_at desc,p.id desc limit ? offset ?', [*args, limit, offset])
    posts = [{**p, 'can_withdraw': can_edit_post(access,p)} for p in rows]
    if include_total:
        total = offset + len(rows)
        if len(rows) == limit or (offset and not rows):
            total = access.db.scalar('select count(*) from parent_posts p '+clause, args)
        return posts, total
    return posts


def thread(access, p_student, p_page=1):
    require_child(access, p_student)
    db = access.db
    page_size = 30
    offset = (p_page - 1) * page_size
    rows = db.all('''select m.id,m.body,m.created_at,p.full_name author_name,m.author_id=? is_own
        from parent_messages m join profiles p on p.id=m.author_id where m.student_id=?
        order by m.created_at desc,m.id desc limit ? offset ?''', (access.actor, p_student, page_size, offset))
    total = offset + len(rows)
    if len(rows) == page_size or (offset and not rows):
        total = db.scalar('select count(*) from parent_messages where student_id=?', (p_student,))
    return {'messages': rows[::-1], 'total': total, 'page': p_page, 'page_size': page_size}


def send_message(access, p_student, p_body):
    child = require_child(access, p_student)
    if not child['is_active']:
        forbidden('Child access is not assigned.')
    item = access.db.insert('parent_messages', {'student_id': p_student,'body': p_body,'author_id': access.actor})
    return {'id': item['id']}


def calendar(access, p_student, p_month, p_include_next_month=False, p_include_care=False):
    child = require_child(access, p_student)
    result = child_calendar(access.db, child, p_month, p_include_next_month)
    if p_include_care:
        result['care'] = teaching.today(access, child)
    return result


def child_calendar(db, child, month, include_next_month=False):
    span = '+2 months' if include_next_month else '+1 month'
    entries = db.all("""
        with period as (select date(?,'start of month') first_day, date(?,'start of month',?) next_day)
        select 'event' entry_type, id, title, body, event_date starts_on, null ends_on
        from parent_posts, period where is_published=1
            and kind='event' and class_id=? and (student_id is null or student_id=?)
            and event_date>=first_day and event_date<next_day
        union all
        select 'holiday', id, name, null, starts_on, ends_on
        from school_holidays, period where is_active=1 and branch_id=?
            and ends_on>=first_day and starts_on<next_day
        order by starts_on,id
        """, (month, month, span, child['class_id'], child['id'], child['branch_id']))
    events, holidays = [], []
    for entry in entries:
        if entry['entry_type'] == 'event':
            events.append({'id': entry['id'], 'title': entry['title'], 'body': entry['body'],
                           'event_date': entry['starts_on']})
        else:
            holidays.append({'id': entry['id'], 'name': entry['title'],
                             'starts_on': entry['starts_on'], 'ends_on': entry['ends_on']})
    return {'events': events, 'holidays': holidays}
