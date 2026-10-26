"""Run only against an empty disposable local test_* PostgreSQL database.

TEST_DATABASE_URL=postgresql://.../test_school python tests/school-database-regressions.py
The test emulates Supabase identities and default grants, then installs every migration.
"""
import os
from pathlib import Path
from uuid import uuid4

import psycopg2
from psycopg2.extras import Json
from psycopg2.extensions import parse_dsn

dsn = os.environ['TEST_DATABASE_URL']
params = parse_dsn(dsn)
assert params.get('host') in {'127.0.0.1', 'localhost'}
assert params.get('dbname', '').startswith('test_')
db = psycopg2.connect(dsn)
db.autocommit = True
c = db.cursor()
c.execute("select to_regclass('public.profiles')")
assert c.fetchone()[0] is None, 'Use an empty disposable test database'
c.execute("""
do $$ begin
 if not exists(select from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
 if not exists(select from pg_roles where rolname='anon') then create role anon nologin; end if;
end $$;
create schema auth;
create table auth.users(id uuid primary key,email text,phone text,email_confirmed_at timestamptz,raw_user_meta_data jsonb default '{}');
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema auth,public to authenticated,anon;
alter default privileges in schema public grant all on tables to authenticated,anon;
alter default privileges in schema public grant execute on functions to authenticated,anon;
""")
root = Path(__file__).resolve().parents[1]
for migration in sorted((root/'supabase/migrations').glob('*.sql')):
    c.execute(migration.read_text())

users = {name: str(uuid4()) for name in ['owner', 'manager', 'admin', 'teacher', 'accountant', 'parent', 'outsider', 'invitee', 'other', 'temporary']}
for name, uid in users.items():
    c.execute("insert into auth.users(id,email,email_confirmed_at) values(%s,%s,now())", (uid, f'{name}@test.invalid'))
a, b = str(uuid4()), str(uuid4())
c.execute("insert into branches(id,name,code) values(%s,'Center A','A'),(%s,'Center B','B')", (a,b))
members = {}
for name, role, branch in [('owner','super_admin',None),('manager','management',None),('admin','branch_admin',a),('teacher','teacher',a),('accountant','accountant',a),('parent','parent',a),('other','teacher',b),('temporary','branch_admin',b)]:
    c.execute('insert into user_memberships(user_id,branch_id,role) values(%s,%s,%s) returning id', (users[name],branch,role))
    members[name]=str(c.fetchone()[0])
checks=0

def login(name):
    c.execute('reset role')
    c.execute("select set_config('request.jwt.claim.sub',%s,false)", (users[name],))
    c.execute('set role authenticated')

def check(condition, label):
    global checks
    assert condition, label
    checks += 1
    print('PASS:',label)

def rpc(name,*args):
    c.execute('select '+name+'('+','.join(['%s']*len(args))+')', tuple(Json(v) if isinstance(v,dict) else v for v in args))
    return c.fetchone()[0]

def save(kind,data,record=None):
    return rpc('school_save_record',kind,data,record['id'] if record else None,record['version'] if record else None)

def denied(fn, marker, label):
    try: fn()
    except psycopg2.Error as error: check(marker in str(error),label)
    else: raise AssertionError(label+' was not rejected')

login('owner')
school=save('school',{'name':'Octominds','email':'school@test.invalid'})
center=save('centers',{'name':'Center C','code':'C','timezone':'Asia/Kolkata'})
check(bool(center['id']),'management creates a center')
year=save('years',{'branch_id':a,'name':'2026-27','starts_on':'2026-04-01','ends_on':'2027-03-31','status':'active'})
year_b=save('years',{'branch_id':b,'name':'2026-27','starts_on':'2026-04-01','ends_on':'2027-03-31'})
program=save('programs',{'branch_id':a,'name':'Nursery'})
program_b=save('programs',{'branch_id':b,'name':'Nursery'})
term=save('terms',{'branch_id':a,'academic_year_id':year['id'],'name':'Term 1','starts_on':'2026-04-01','ends_on':'2026-09-30'})
klass=save('classes',{'branch_id':a,'academic_year_id':year['id'],'program_id':program['id'],'name':'Nursery','section':'A','capacity':20})
assignment=save('assignments',{'branch_id':a,'class_id':klass['id'],'user_id':users['teacher'],'starts_on':'2026-04-01','ends_on':'2027-03-31'})
holiday=save('holidays',{'branch_id':a,'name':'School holiday','starts_on':'2026-12-25','ends_on':'2026-12-25'})
check(assignment['user_id']==users['teacher'],'setup workflow creates year, program, term, class and teacher assignment')
denied(lambda:save('classes',{'branch_id':a,'academic_year_id':year['id'],'program_id':program_b['id'],'name':'Cross center','capacity':20}),'active program','cross-center program rejected')
denied(lambda:save('terms',{'branch_id':a,'academic_year_id':year['id'],'name':'Outside','starts_on':'2025-01-01','ends_on':'2025-02-01'}),'Term dates','term outside academic year rejected')
denied(lambda:save('assignments',{'branch_id':a,'class_id':klass['id'],'user_id':users['other'],'starts_on':'2026-05-01'}),'Teacher needs','teacher from another center rejected')
denied(lambda:save('assignments',{'branch_id':a,'class_id':klass['id'],'user_id':users['teacher'],'starts_on':'2030-05-01'}),'Assignment dates','assignment after year end rejected')
denied(lambda:save('years',{'ends_on':'2026-10-01'},year),'teacher assignments','year cannot truncate assignment history')
denied(lambda:save('years',{'branch_id':a,'name':'Another active','starts_on':'2027-04-01','ends_on':'2028-03-31','status':'active'}),'academic_year_one_active','one active year per center')
denied(lambda:save('centers',{'name':'Invalid timezone','code':'BAD','timezone':'Imaginary/Zone'}),'Unknown timezone','timezone validated inside database')
denied(lambda:save('centers',{'name':'Invalid hours','code':'HOURS','opens_at':'18:00','closes_at':'09:00'}),'branch_hours','invalid opening hours rejected')
updated=save('programs',{'name':'Nursery updated'},program)
check(updated['version']==2,'version increments after update')
denied(lambda:save('programs',{'name':'Stale'},program),'record changed','stale edits cannot overwrite newer record')
denied(lambda:save('programs',{'branch_id':b},updated),'cannot move','existing records cannot move between centers')
denied(lambda:save('programs',{'version':999},updated),'Unsupported record field','RPC field allowlist rejects metadata injection')
closed=save('years',{'status':'closed'},year)
denied(lambda:save('years',{'status':'active'},closed),'read only','closed year cannot be reopened or rewritten')
denied(lambda:save('classes',{'name':'Rewritten history'},klass),'open academic year','classes in closed year cannot change')
denied(lambda:save('terms',{'name':'Rewritten term'},term),'open academic year','terms in closed year cannot change')
denied(lambda:save('assignments',{'user_id':users['other']},assignment),'new assignment','teacher assignment identity preserves historical records')

login('admin')
check(save('holidays',{'name':'Updated holiday'},holiday)['version']==2,'center admin can maintain own center')
denied(lambda:save('programs',{'branch_id':b,'name':'Unauthorized'}),'administration access','center admin cannot write another center')
denied(lambda:save('centers',{'name':'Unauthorized','code':'NO'}),'management access','center admin cannot create centers')
denied(lambda:save('school',{'name':'Hijacked'},school),'management access','center admin cannot edit school identity')
denied(lambda:rpc('school_access_command','grant',{'user_id':users['parent'],'role':'super_admin'}),'cannot assign','center admin cannot grant global access')
denied(lambda:rpc('school_access_command','grant',{'user_id':users['parent'],'role':'branch_admin','branch_id':a}),'cannot assign','center admin cannot create other center administrators')
directory=rpc('school_access_directory')
check(all(m['branch_id']==a for m in directory['memberships']),'account directory is center scoped')
check(users['other'] not in [u['id'] for u in directory['users']],'account directory hides unrelated identities')
denied(lambda:c.execute("update branches set name='Bypass' where id=%s",(a,)),'permission denied','direct table write cannot bypass audit commands')
c.execute("update user_memberships set role='super_admin' where user_id=auth.uid()")
check(c.rowcount==0,'direct membership update cannot elevate role')
invite=rpc('school_access_command','invite',{'email':'invitee@test.invalid','full_name':'Invited Teacher','role':'teacher','branch_id':a})
check(len(invite['token'])==64,'invitation returns a one-time random token')
check('token_hash' not in str(rpc('school_access_directory')) and invite['token'] not in str(rpc('school_access_directory')),'directory never exposes invitation secrets')
login('outsider')
check(rpc('school_access_directory')['users']==[],'unassigned account sees no access directory')
denied(lambda:rpc('school_accept_invitation',invite['token']),'different verified email','invitation cannot be stolen by another account')
login('invitee')
c.execute('reset role');c.execute('update auth.users set email_confirmed_at=null where id=%s',(users['invitee'],));login('invitee')
denied(lambda:rpc('school_accept_invitation',invite['token']),'verified email','unverified email cannot accept')
c.execute('reset role');c.execute('update auth.users set email_confirmed_at=now() where id=%s',(users['invitee'],));login('invitee')
accepted=rpc('school_accept_invitation',invite['token'])
check(bool(accepted['id']),'verified invitee accepts without existing membership')
denied(lambda:rpc('school_accept_invitation',invite['token']),'used','invitation replay rejected')
denied(lambda:save('programs',{'branch_id':a,'name':'Teacher write'}),'administration access','teacher cannot edit school setup')

login('teacher')
c.execute('select id from academic_years');check([str(r[0]) for r in c.fetchall()]==[year['id']],'teacher reads only authorized center setup')
c.execute('select user_id from teacher_assignments');check([str(r[0]) for r in c.fetchall()]==[users['teacher']],'teacher sees only own assignments')
check(rpc('has_inventory_access',a,False) is False,'teacher sign-in does not grant inventory access')
login('parent')
c.execute('select id from teacher_assignments');check(c.fetchall()==[],'parent cannot read staff assignments')
denied(lambda:rpc('school_access_command','invite',{'email':'new@test.invalid','full_name':'New','role':'teacher','branch_id':a}),'cannot assign','parent cannot invite staff')
login('accountant')
check(rpc('has_inventory_access',a,False) and not rpc('has_inventory_access',a,True),'accountant inventory read-only preserved')

login('owner')
grant=rpc('school_access_command','grant',{'user_id':users['parent'],'role':'accountant','branch_id':a})
check(bool(grant['id']),'owner assigns an additional role to existing account')
denied(lambda:rpc('school_access_command','grant',{'user_id':users['owner'],'role':'teacher','branch_id':a}),'Another administrator','self access changes rejected')
denied(lambda:rpc('school_access_command','status',{'user_id':users['owner'],'is_active':False}),'another account','owner cannot suspend themselves')
denied(lambda:rpc('school_access_command','grant',{'user_id':users['teacher'],'role':'super_admin','expires_at':'2030-01-01T00:00:00Z'}),'cannot expire','owner role cannot automatically expire')
rpc('school_access_command','status',{'user_id':users['teacher'],'is_active':False})
login('teacher')
c.execute('select id from academic_years');check(c.fetchall()==[],'suspension blocks database reads immediately with existing identity')
denied(lambda:save('holidays',{'branch_id':a,'name':'Disabled','starts_on':'2026-12-01','ends_on':'2026-12-01'}),'administration access','suspended account cannot mutate')
login('owner')
rpc('school_access_command','status',{'user_id':users['teacher'],'is_active':True})
rpc('school_access_command','revoke',{'id':grant['id']})
login('parent');check(not rpc('has_inventory_access',a,False),'revocation removes inventory entitlement immediately')
login('manager')
denied(lambda:rpc('school_access_command','status',{'user_id':users['teacher'],'is_active':False}),'owner','management cannot globally suspend accounts')
denied(lambda:rpc('school_access_command','invite',{'email':'new@test.invalid','full_name':'New','role':'super_admin'}),'cannot assign','management cannot invite owners')

login('temporary')
dead=rpc('school_access_command','invite',{'email':'outsider@test.invalid','full_name':'New','role':'teacher','branch_id':b})
c.execute('reset role');c.execute("update user_memberships set expires_at=now()-interval '1 second' where id=%s",(members['temporary'],));login('temporary')
check(not rpc('has_inventory_access',b,True),'expired temporary access blocks inventory writes')
denied(lambda:save('programs',{'branch_id':b,'name':'Expired'}),'administration access','expired access blocks school writes')
c.execute('select id from user_memberships');check(c.fetchall()==[],'expired memberships not returned to session resolver')
login('outsider')
denied(lambda:rpc('school_accept_invitation',dead['token']),'issuer no longer','invitation loses authority when issuer access expires')
login('owner')
revoked=rpc('school_access_command','invite',{'email':'outsider@test.invalid','full_name':'New','role':'parent','branch_id':a})
rpc('school_access_command','revoke_invite',{'id':revoked['id']})
login('outsider');denied(lambda:rpc('school_accept_invitation',revoked['token']),'invalid','revoked invitation rejected')
login('owner')
check(len(rpc('school_access_directory')['audit'])>=15,'setup and access changes write audit events')
c.execute('reset role');c.execute('set role anon')
check(rpc('school_readiness')['schema_version']=='202610260001','anonymous readiness verifies combined migration state')
denied(lambda:rpc('school_access_directory'),'permission denied','anonymous directory RPC blocked')
denied(lambda:rpc('school_save_record','centers',{'name':'Anon','code':'ANON'},None,None),'permission denied','anonymous write RPC blocked')
print(f'{checks} school database checks passed')
db.close()
