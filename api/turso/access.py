"""Authorization uses the request actor and the current database snapshot."""
from functools import cached_property

from fastapi import HTTPException

GLOBAL = {'super_admin', 'management'}
BRANCH_ROLES = {'teacher', 'admission_counsellor', 'accountant', 'parent'}


def forbidden(message='You do not have access to this record.'):
    raise HTTPException(403, message)


def invalid(message):
    raise HTTPException(422, message)


class Access:
    def __init__(self, db, actor):
        self.db, self.actor = db, actor
        self.memberships = db.all("""
            select m.* from user_memberships m join profiles p on p.id=m.user_id
            where m.user_id=? and p.is_active=1 and m.is_active=1
            and (m.expires_at is null or julianday(m.expires_at)>julianday('now'))
            """, (actor,))
        self.global_roles = {m['role'] for m in self.memberships if m['role'] in GLOBAL}
        self.roles = {}
        for membership in self.memberships:
            self.roles.setdefault(membership['branch_id'], set()).add(membership['role'])

    @cached_property
    def branches(self):
        return {branch['id']: branch for branch in self.db.all('select * from branches')}

    def active(self, branch):
        return bool(self.branches.get(branch, {}).get('is_active'))

    def school_read(self, branch):
        return bool(self.global_roles or (self.active(branch) and self.roles.get(branch)))

    def manage(self, branch):
        return bool(self.global_roles or (self.active(branch) and 'branch_admin' in self.roles.get(branch, set())))

    def inventory(self, branch, write=False):
        roles = {'branch_admin'} if write else {'branch_admin', 'accountant'}
        return self.active(branch) and bool(self.global_roles or self.roles.get(branch, set()) & roles)

    def may_grant(self, role, branch):
        if role in GLOBAL:
            return branch is None and 'super_admin' in self.global_roles
        return self.active(branch) and bool(self.global_roles or (role in BRANCH_ROLES and self.manage(branch)))

    def class_open(self, class_id):
        return self.db.one("""
            select c.* from school_classes c join academic_years y on y.id=c.academic_year_id
            join branches b on b.id=c.branch_id
            where c.id=? and c.is_active=1 and b.is_active=1 and y.status<>'closed'
            """, (class_id,))

    @cached_property
    def managed_branches(self):
        if self.global_roles:
            return set(self.branches)
        return {branch for branch, roles in self.roles.items() if 'branch_admin' in roles and self.active(branch)}

    @cached_property
    def class_ids(self):
        if not self.managed_branches and not any('teacher' in roles for roles in self.roles.values()):
            return set()
        rows = self.db.all("""
            select c.id,c.branch_id,a.id as assignment_id from school_classes c
            join branches b on b.id=c.branch_id join academic_years y on y.id=c.academic_year_id
            left join teacher_assignments a on a.class_id=c.id and a.user_id=? and a.is_active=1
            and a.starts_on<=date('now') and (a.ends_on is null or a.ends_on>=date('now'))
            where c.is_active=1 and b.is_active=1 and y.status<>'closed'
            """, (self.actor,))
        return {row['id'] for row in rows if row['branch_id'] in self.managed_branches
                or (row['assignment_id'] and 'teacher' in self.roles.get(row['branch_id'], set()))}

    @cached_property
    def guardian_links(self):
        if not any('parent' in roles for roles in self.roles.values()):
            return {}
        return {row['student_id']:row['relationship'] for row in self.db.all("""
            select g.student_id,g.relationship from parent_guardians g
            join parent_students s on s.id=g.student_id
            join user_memberships m on m.branch_id=s.branch_id and m.user_id=g.user_id
            where g.user_id=? and g.is_active=1 and m.is_active=1 and m.role='parent'
            and (m.expires_at is null or julianday(m.expires_at)>julianday('now'))
            """, (self.actor,))}

    def teach(self, class_id):
        return class_id in self.class_ids

    def child(self, student):
        if not student or not self.active(student['branch_id']):
            return False
        return student['branch_id'] in self.managed_branches or (
            student['is_active'] and (self.teach(student['class_id']) or student['id'] in self.guardian_links))

    def audit(self, event, entity, key, branch=None, metadata=None):
        self.db.insert('audit_events', {'actor_user_id': self.actor, 'branch_id': branch,
            'event_type': event, 'entity_type': entity, 'entity_id': key, 'metadata': metadata or {}})
