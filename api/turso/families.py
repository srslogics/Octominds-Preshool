"""Family portal records and scoped class communication."""
from fastapi import HTTPException

from ..auth import mobile_from_login
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



def workspace(access):
    db = access.db
    classes = db.all("""select c.id,c.branch_id,trim(c.name||' '||c.section) name,b.name center_name,y.name year_name
        from school_classes c join branches b on b.id=c.branch_id join academic_years y on y.id=c.academic_year_id
        where c.is_active=1 and b.is_active=1 and y.status<>'closed' order by b.name,c.name,c.section""")
    classes = [{**c, 'can_manage': access.manage(c['branch_id'])} for c in classes if access.teach(c['id'])]
    students = scoped_children(access)
    for child in students:
        child.update(can_manage=access.manage(child['branch_id']), can_publish=access.teach(child['class_id']),
                     relationship=access.guardian_links.get(child['id']))
    guardians = [g for g in db.all('select g.*,s.branch_id from parent_guardians g join parent_students s on s.id=g.student_id')
                 if access.manage(g.pop('branch_id'))]
    accounts = db.all("""select p.id user_id,m.branch_id,p.full_name,a.email from profiles p
        join accounts a on a.id=p.id join user_memberships m on m.user_id=p.id
        where p.is_active=1 and a.email_confirmed_at is not null and m.is_active=1 and m.role='parent'
        and (m.expires_at is null or julianday(m.expires_at)>julianday('now')) order by p.full_name""")
    return {'classes': classes, 'students': students, 'guardians': guardians,
            'parent_accounts': [{**a, 'phone': mobile_from_login(a['email'])}
                                for a in accounts if access.manage(a['branch_id'])]}


def save_student(access, p_data):
    data = dict(p_data)
    ident, version = data.pop('id'), data.pop('version')
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
    db = access.db
    clause = 'where p.is_published=1 and p.class_id=? and (p.student_id is null or p.student_id=?)'
    args = [child['class_id'], p_student]
    if p_kind != 'all':
        clause += ' and p.kind=?'
        args.append(p_kind)
    total = db.scalar('select count(*) from parent_posts p '+clause, args)
    rows = db.all('''select p.*,a.full_name author_name from parent_posts p join profiles a on a.id=p.created_by '''
                  +clause+' order by p.created_at desc,p.id desc limit 20 offset ?', [*args, (p_page-1)*20])
    return {'posts': [{**p, 'can_withdraw': can_edit_post(access,p)} for p in rows],
            'total': total, 'page': p_page, 'page_size': 20}


def thread(access, p_student, p_page=1):
    require_child(access, p_student)
    db = access.db
    rows = db.all('''select m.id,m.body,m.created_at,p.full_name author_name,m.author_id=? is_own
        from parent_messages m join profiles p on p.id=m.author_id where m.student_id=?
        order by m.created_at desc,m.id desc limit 30 offset ?''', (access.actor,p_student,(p_page-1)*30))
    total = db.scalar('select count(*) from parent_messages where student_id=?', (p_student,))
    return {'messages': rows[::-1], 'total': total, 'page': p_page, 'page_size': 30}


def send_message(access, p_student, p_body):
    child = require_child(access, p_student)
    if not child['is_active']:
        forbidden('Child access is not assigned.')
    item = access.db.insert('parent_messages', {'student_id': p_student,'body': p_body,'author_id': access.actor})
    return {'id': item['id']}


def calendar(access, p_student, p_month):
    child = require_child(access, p_student)
    db = access.db
    events = db.all("""select id,title,body,event_date from parent_posts where is_published=1
        and kind='event' and class_id=? and (student_id is null or student_id=?)
        and event_date>=date(?,'start of month') and event_date<date(?,'start of month','+1 month')
        order by event_date,id""", (child['class_id'], p_student, p_month, p_month))
    holidays = db.all("""select id,name,starts_on,ends_on from school_holidays where is_active=1 and branch_id=?
        and ends_on>=date(?,'start of month') and starts_on<date(?,'start of month','+1 month') order by starts_on,id""",
        (child['branch_id'],p_month,p_month))
    return {'events': events, 'holidays': holidays}
