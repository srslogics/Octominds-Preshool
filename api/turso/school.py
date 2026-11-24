"""School setup, branch-scoped administration and invitation acceptance."""
import secrets
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import HTTPException

from ..auth import mobile_from_login, mobile_login
from . import families
from .access import GLOBAL, Access, forbidden, invalid
from .db import now, token_hash

TABLES = {'school': 'school_settings', 'centers': 'branches', 'years': 'academic_years',
          'terms': 'school_terms', 'programs': 'school_programs', 'classes': 'school_classes',
          'assignments': 'teacher_assignments', 'holidays': 'school_holidays'}


def scope_rows(access, table):
    if table == 'user_memberships':
        return access.memberships
    if table not in TABLES.values():
        raise ValueError('Invalid school table')
    if table == 'school_settings':
        return access.db.all('select * from school_settings') if access.memberships else []
    if table == 'branches':
        return [b for b in access.branches.values() if access.school_read(b['id'])]
    permitted = [b for b in access.branches if access.school_read(b)]
    if not permitted:
        return []
    placeholders = ','.join('?' for _ in permitted)
    params = list(permitted)
    extra = ''
    if table == 'teacher_assignments':
        managed = [b for b in permitted if access.manage(b)]
        slots = ','.join('?' for _ in managed)
        extra = f' and (user_id=? or branch_id in ({slots}))'
        params.extend([access.actor, *managed])
    return access.db.all(f'select * from {table} where branch_id in ({placeholders}){extra} order by id', params)


def workspace(access, p_include_directory=False):
    rows = {kind: scope_rows(access,table) for kind,table in TABLES.items()}
    result = {**rows, 'memberships': access.memberships, 'students': families.enrollment_students(access)}
    if p_include_directory and (access.global_roles or access.managed_branches):
        result['directory'] = directory(access)
    return result


def require_open_year(access, year_id, branch):
    year = access.db.one('select * from academic_years where id=? and branch_id=?', (year_id, branch))
    if not year or year['status'] == 'closed':
        invalid('Choose an open academic year in this center.')
    return year


def save_record(access, p_kind, p_data, p_id=None, p_version=None):
    db = access.db
    table = TABLES[p_kind]
    old = db.one(f'select * from {table} where id=?', (p_id,)) if p_id else None
    if p_id and not old:
        raise HTTPException(404, 'Record is unavailable.')
    branch = p_id if p_kind == 'centers' else (old or p_data).get('branch_id')
    if p_kind == 'school' or (p_kind == 'centers' and not p_id):
        if not access.global_roles:
            forbidden('School management access required.')
    elif not access.manage(branch):
        forbidden('Center administration access required.')
    if old and old['version'] != p_version:
        raise HTTPException(409, 'This record changed. Reload before saving.')
    if old and p_kind not in {'school', 'centers'} and p_data.get('branch_id') != old['branch_id']:
        invalid('Records cannot move between centers.')
    if p_kind == 'centers':
        if 'is_active' in p_data and not access.global_roles:
            forbidden('Only management can activate or archive centers.')
        try:
            ZoneInfo(p_data.get('timezone', 'Asia/Kolkata'))
        except (ZoneInfoNotFoundError, ValueError):
            invalid('Choose a valid timezone.')
    if p_kind == 'years' and old:
        if old['status'] == 'closed':
            invalid('Closed academic years are read only.')
        bounds = (p_id, p_data['starts_on'], p_data['ends_on'])
        if db.scalar('select 1 from school_terms where academic_year_id=? and (starts_on<? or ends_on>?)', bounds):
            invalid('Year dates must contain all terms.')
        if db.scalar('''select 1 from teacher_assignments a join school_classes c on c.id=a.class_id
                      where c.academic_year_id=? and (a.starts_on<? or coalesce(a.ends_on,a.starts_on)>?)''', bounds):
            invalid('Year dates must contain teacher assignments.')
    if p_kind in {'terms', 'classes'}:
        year = require_open_year(access, p_data['academic_year_id'], branch)
        if old and old['academic_year_id'] != year['id']:
            invalid('Create a new record for another academic year.')
        if p_kind == 'terms' and (p_data['starts_on'] < year['starts_on'] or p_data['ends_on'] > year['ends_on']):
            invalid('Term dates must fall within the academic year.')
        if p_kind == 'classes' and not db.scalar('select 1 from school_programs where id=? and branch_id=? and is_active=1',
                                                 (p_data['program_id'], branch)):
            invalid('Choose an active program in this center.')
    if p_kind == 'assignments':
        classroom = access.class_open(p_data['class_id'])
        teacher = p_data['user_id']
        if not classroom or classroom['branch_id'] != branch:
            invalid('Choose an active class in an open year.')
        if old and (old['class_id'] != classroom['id'] or old['user_id'] != teacher):
            invalid('Create a new assignment when changing class or teacher.')
        year = require_open_year(access, classroom['academic_year_id'], branch)
        if (not year['starts_on'] <= p_data['starts_on'] <= year['ends_on']
                or (p_data['ends_on'] and p_data['ends_on'] > year['ends_on'])):
            invalid('Assignment dates must fall within the academic year.')
        if p_data['is_active'] and 'teacher' not in Access(db, teacher).roles.get(branch, set()):
            invalid('Teacher needs active access to this center.')
        if not old:
            existing = db.one('''select * from teacher_assignments
                where class_id=? and user_id=? and starts_on=? and ends_on is ? and is_active=?
                order by id limit 1''',
                (classroom['id'], teacher, p_data['starts_on'], p_data['ends_on'], p_data['is_active']))
            if existing:
                return existing
    values = {**p_data, 'updated_at': now()}
    result = db.update(table, p_id, {**values, 'version': p_version+1}) if p_id else db.insert(table, values)
    access.audit('school.record_saved', p_kind, result['id'],
                 result['id'] if p_kind == 'centers' else branch, {'before': old, 'after': result})
    return result


def assign_classes(access, data, class_ids):
    return [save_record(access, 'assignments', {**data, 'class_id': class_id}) for class_id in class_ids]


def directory(access):
    db = access.db
    memberships = [m for m in db.all('select * from user_memberships order by created_at desc') if access.manage(m['branch_id'])]
    member_ids = {m['user_id'] for m in memberships}
    users = [u for u in db.all('select p.id,p.full_name,p.is_active,a.email from profiles p join accounts a on a.id=p.id order by p.full_name')
             if u['id'] in member_ids]
    invitations = [i for i in db.all('''select i.id,i.email,i.full_name,i.branch_id,i.role,i.expires_at,i.membership_expires_at,
        i.created_by,i.created_at,i.accepted_by,i.accepted_at,i.revoked_at,s.full_name student_name
        from school_invitations i left join school_invitation_students l on l.invitation_id=i.id
        left join parent_students s on s.id=l.student_id order by i.created_at desc''')
                   if access.manage(i['branch_id'])]
    audit = []
    if access.global_roles or access.managed_branches:
        scope = '' if access.global_roles else f"and branch_id in ({','.join('?' for _ in access.managed_branches)})"
        audit = db.all(f"""select id,actor_user_id,branch_id,event_type,entity_type,entity_id,occurred_at
            from audit_events where event_type like 'school.%' {scope} order by occurred_at desc,id desc limit 100""",
            () if access.global_roles else access.managed_branches)
    for record in users + invitations:
        record['phone'] = mobile_from_login(record['email'])
    return {'memberships': memberships, 'users': users, 'invitations': invitations, 'audit': audit}


def expiry_value(value, role):
    if not value:
        return None
    when = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if when.tzinfo is None or when <= datetime.now(UTC):
        invalid('Access expiry must be in the future and include a timezone.')
    if role == 'super_admin':
        invalid('Owner access cannot expire automatically.')
    return when.astimezone(UTC).isoformat()


def other_owner(db, target):
    return db.scalar("""select 1 from user_memberships m join profiles p on p.id=m.user_id
      where p.id<>? and p.is_active=1 and m.role='super_admin' and m.is_active=1
      and (m.expires_at is null or julianday(m.expires_at)>julianday('now'))""", (target,))


def existing_membership(access, role, branch):
    return next((member for member in access.memberships
                 if member['role'] == role and member['branch_id'] == branch), None)


def connect_enrolled_guardian(access, guardian_id, branch, details):
    families.require_enrollment_student(access, details['student_id'], branch)
    return families.link_guardian(access, {'student_id': details['student_id'], 'user_id': guardian_id,
                                          'relationship': details['relationship'], 'is_active': True})


def access_command(access, p_action, p_data):
    db = access.db
    branch, role = p_data.get('branch_id'), p_data.get('role')
    if p_action == 'invite':
        if not access.may_grant(role, branch):
            forbidden('You cannot assign this role or center.')
        token = secrets.token_hex(32)
        phone = p_data.get('phone')
        login = mobile_login(phone) if phone else p_data['email'].lower()
        row = db.insert('school_invitations', {'email': login, 'full_name': p_data['full_name'],
            'branch_id': branch, 'role': role, 'token_hash': token_hash(token), 'created_by': access.actor,
            'expires_at': (datetime.now(UTC)+timedelta(days=7)).isoformat(),
            'membership_expires_at': expiry_value(p_data.get('expires_at'), role)})
        if p_data.get('student_id'):
            student_id = p_data['student_id']
            families.require_enrollment_student(access, student_id, branch)
            db.insert('school_invitation_students', {'invitation_id': row['id'], 'student_id': student_id,
                      'relationship': p_data['relationship']}, generate_id=False)
            families.save_guardian_contact(db, student_id, p_data)
        result = {'id': row['id'], 'token': token, 'expires_at': row['expires_at']}
    elif p_action == 'revoke_invite':
        row = db.one('select * from school_invitations where id=?', (p_data['id'],))
        if not row or not access.may_grant(row['role'], row['branch_id']):
            forbidden('Invitation is unavailable.')
        if row['accepted_at']:
            invalid('Remove the membership to revoke an accepted invitation.')
        branch = row['branch_id']
        db.update('school_invitations', row['id'], {'revoked_at': now()})
        result = {'id': row['id']}
    elif p_action in {'grant', 'revoke'}:
        if p_action == 'revoke':
            row = db.one('select * from user_memberships where id=?', (p_data['id'],))
            if not row:
                raise HTTPException(404, 'Membership is unavailable.')
            target, branch, role = row['user_id'], row['branch_id'], row['role']
        else:
            target = p_data['user_id']
        if not access.may_grant(role, None if role in GLOBAL and p_action=='revoke' else branch) or target == access.actor:
            forbidden('You cannot assign this role or change your own account access.')
        if not access.global_roles and not db.scalar(
                'select 1 from user_memberships where user_id=? and branch_id=? and is_active=1', (target, branch)):
            forbidden('Use an invitation for a new center member.')
        if p_action == 'revoke':
            if role == 'super_admin' and not other_owner(db, target):
                invalid('Keep at least one active owner.')
            db.update('user_memberships', row['id'], {'is_active': False, 'updated_at': now()})
        else:
            if not db.scalar('select 1 from profiles where id=? and is_active=1', (target,)):
                invalid('Choose an active account.')
            student_id = p_data.get('student_id')
            row = existing_membership(Access(db, target), role, branch) if student_id else None
            if row is None:
                row = db.insert('user_memberships', {'user_id': target, 'branch_id': branch, 'role': role,
                            'expires_at': expiry_value(p_data.get('expires_at'), role)})
            if student_id:
                connect_enrolled_guardian(access, target, branch, p_data)
        result = {'id': row['id']}
    else:
        target = p_data['user_id']
        if 'super_admin' not in access.global_roles or target == access.actor:
            forbidden('An owner must change another account status.')
        active = p_data['is_active']
        if (not active and db.scalar("select 1 from user_memberships where user_id=? and role='super_admin' and is_active=1", (target,))
                and not other_owner(db, target)):
            invalid('Keep at least one active owner.')
        if not db.update('profiles', target, {'is_active': active, 'updated_at': now()}):
            raise HTTPException(404, 'Account is unavailable.')
        if not active:
            db.execute('delete from auth_sessions where user_id=?', (target,))
            db.execute('delete from auth_recovery where user_id=?', (target,))
        result = {'id': target}
    access.audit(f'school.access_{p_action}', 'access', result['id'], branch, p_data)
    return result


def valid_invitation(db, token, login):
    invitation = db.one("""
        select * from school_invitations where token_hash=? and lower(email)=? and revoked_at is null
        and accepted_at is null and julianday(expires_at)>julianday('now')
        and (membership_expires_at is null or julianday(membership_expires_at)>julianday('now'))
        """, (token_hash(token), login))
    if not invitation or not Access(db, invitation['created_by']).may_grant(invitation['role'], invitation['branch_id']):
        forbidden('This invitation is invalid or has expired.')
    return invitation


def complete_invitation(access, invitation):
    db = access.db
    mobile = mobile_from_login(invitation['email'])
    role, branch = invitation['role'], invitation['branch_id']
    enrollment = db.one('select student_id,relationship from school_invitation_students where invitation_id=?',
                        (invitation['id'],))
    membership = existing_membership(access, role, branch) if mobile or enrollment else None
    if membership is None:
        membership = db.insert('user_memberships', {'user_id': access.actor, 'role': role,
            'branch_id': branch, 'expires_at': invitation['membership_expires_at']})
    if not mobile and not enrollment:
        db.update('profiles', access.actor, {'full_name': invitation['full_name'], 'updated_at': now()})
    if enrollment:
        issuer = Access(db, invitation['created_by'])
        connect_enrolled_guardian(issuer, access.actor, branch, enrollment)
    db.update('school_invitations', invitation['id'], {'accepted_by': access.actor, 'accepted_at': now()})
    access.audit('school.invitation_accepted', 'membership', membership['id'], branch)
    return {'id': membership['id'], 'role': role}


def accept_invitation(access, p_token):
    db = access.db
    login = db.scalar('select email from accounts where id=? and email_confirmed_at is not null', (access.actor,))
    return complete_invitation(access, valid_invitation(db, p_token, login))
