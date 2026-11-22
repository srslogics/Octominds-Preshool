"""Requires an EMPTY disposable local test_* database; installs all migrations.
TEST_DATABASE_URL=postgresql://.../test_parents python tests/parents-database-regressions.py
"""
import os
from datetime import date, timedelta
from pathlib import Path
from uuid import uuid4
import psycopg2
from psycopg2.extras import Json
from psycopg2.extensions import parse_dsn

params = parse_dsn(os.environ['TEST_DATABASE_URL'])
assert params.get('host') in {'127.0.0.1', 'localhost'}, 'Only disposable local databases are allowed'
assert params.get('dbname', '').startswith('test_'), 'Database must be named test_*'
db = psycopg2.connect(os.environ['TEST_DATABASE_URL']); db.autocommit = True; c = db.cursor()
c.execute("select count(*) from information_schema.tables where table_schema in ('public','auth')")
assert c.fetchone()[0] == 0, 'Use an empty disposable database'
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
c.execute((Path(__file__).resolve().parent/'storage-fixture.sql').read_text())
for path in sorted((Path(__file__).resolve().parents[1]/'supabase/migrations').glob('*.sql')):
    c.execute(path.read_text())
users = {name: str(uuid4()) for name in ['owner','admin','teacher','other_teacher','parent','unlinked','other_parent','inactive','unverified']}
for name, uid in users.items():
    c.execute('insert into auth.users(id,email,email_confirmed_at) values(%s,%s,%s)', (uid, name+'@test.invalid', None if name=='unverified' else '2026-01-01'))
a, b = str(uuid4()), str(uuid4())
c.execute("insert into branches(id,name,code) values(%s,'Green Park','GP'),(%s,'Lake Road','LR')", (a,b))
for name, role, branch in [('owner','super_admin',None),('admin','branch_admin',a),('teacher','teacher',a),('other_teacher','teacher',a),('parent','parent',a),('unlinked','parent',a),('other_parent','parent',b),('inactive','parent',a),('unverified','parent',a)]:
    c.execute('insert into user_memberships(user_id,branch_id,role) values(%s,%s,%s)', (users[name],branch,role))
c.execute('update profiles set is_active=false where id=%s', (users['inactive'],))
checks=0

def login(name):
    c.execute('reset role'); c.execute("select set_config('request.jwt.claim.sub',%s,false)", (users[name],)); c.execute('set role authenticated')

def check(value,label):
    global checks
    assert value,label; checks+=1; print('PASS:',label)

def rpc(name,*args):
    c.execute('select '+name+'('+','.join(['%s']*len(args))+')', tuple(Json(v) if isinstance(v,dict) else v for v in args)); return c.fetchone()[0]

def denied(fn,code,label):
    try: fn()
    except psycopg2.Error as error: check(error.pgcode==code,label)
    else: raise AssertionError(label+' was allowed')

login('owner')
today=date.today();start=(today-timedelta(days=30)).isoformat();end=(today+timedelta(days=300)).isoformat()
classes=[]
for branch in [a,b]:
    year=rpc('school_save_record','years',{'branch_id':branch,'name':'Current year','starts_on':start,'ends_on':end,'status':'active'})
    program=rpc('school_save_record','programs',{'branch_id':branch,'name':'Nursery'})
    classes.append(rpc('school_save_record','classes',{'branch_id':branch,'academic_year_id':year['id'],'program_id':program['id'],'name':'Nursery','capacity':20}))
ca,cb=classes
assignment=rpc('school_save_record','assignments',{'branch_id':a,'class_id':ca['id'],'user_id':users['teacher'],'starts_on':start,'ends_on':end})
s1=rpc('parents_save_student',{'branch_id':a,'class_id':ca['id'],'full_name':'Child One'})
s2=rpc('parents_save_student',{'branch_id':a,'class_id':ca['id'],'full_name':'Child Two'})
s3=rpc('parents_save_student',{'branch_id':b,'class_id':cb['id'],'full_name':'Other Center Child'})
check(s1['version']==1,'administrator registers a child')
link={'student_id':s1['id'],'user_id':users['parent'],'relationship':'Guardian','is_active':True}
rpc('parents_link_guardian',link)
denied(lambda:rpc('parents_link_guardian',{**link,'user_id':users['other_parent']}),'22023','cross-center parent link rejected')
denied(lambda:rpc('parents_link_guardian',{**link,'user_id':users['inactive']}),'22023','inactive parent link rejected')
denied(lambda:rpc('parents_link_guardian',{**link,'user_id':users['unverified']}),'22023','unverified parent link rejected')
denied(lambda:rpc('parents_save_student',{'branch_id':a,'class_id':cb['id'],'full_name':'Wrong class'}),'22023','cross-center class rejected')
updated=rpc('parents_save_student',{'id':s1['id'],'version':1,'branch_id':a,'class_id':ca['id'],'full_name':'Child One Updated'})
check(updated['version']==2,'child edit version increments')
denied(lambda:rpc('parents_save_student',{'id':s1['id'],'version':1,'branch_id':a,'class_id':ca['id'],'full_name':'Stale'}),'40001','stale child edit rejected')
login('admin')
denied(lambda:rpc('parents_save_student',{'branch_id':b,'class_id':cb['id'],'full_name':'Wrong center'}),'42501','center administrator cannot register elsewhere')
login('teacher')
shared=rpc('parents_publish',{'class_id':ca['id'],'kind':'homework','title':'Count together','body':'Find five leaves'})
private=rpc('parents_publish',{'class_id':ca['id'],'student_id':s2['id'],'kind':'diary','title':'Private note','body':'Only for child two'})
event=rpc('parents_publish',{'class_id':ca['id'],'kind':'event','title':'Family morning','body':'Welcome families','event_date':today.isoformat()})
check(bool(shared['id']),'assigned teacher publishes homework')
denied(lambda:rpc('parents_publish',{'class_id':cb['id'],'kind':'notice','title':'No','body':'No'}),'42501','teacher cannot publish to another center')
denied(lambda:rpc('parents_publish',{'class_id':ca['id'],'student_id':s3['id'],'kind':'diary','title':'No','body':'No'}),'22023','child-targeted post must match class')
denied(lambda:rpc('parents_save_student',{'branch_id':a,'class_id':ca['id'],'full_name':'Unauthorized'}),'42501','teacher cannot register children')
denied(lambda:rpc('parents_link_guardian',link),'42501','teacher cannot grant family access')
login('other_teacher')
check(rpc('parents_workspace')['students']==[],'unassigned teacher sees no children')
denied(lambda:rpc('parents_publish',{'class_id':ca['id'],'kind':'notice','title':'No','body':'No'}),'42501','unassigned teacher cannot publish')
login('parent')
w=rpc('parents_workspace');check([s['id'] for s in w['students']]==[s1['id']],'parent sees only their linked child, not classmates')
check(w['classes']==[] and w['parent_accounts']==[] and w['guardians']==[],'parent cannot read staff or guardian directories')
feed=rpc('parents_feed',s1['id']);check(shared['id'] in [p['id'] for p in feed['posts']],'parent reads class homework')
check(private['id'] not in [p['id'] for p in feed['posts']],'private diary for classmate is hidden')
check(all(not p['can_withdraw'] for p in feed['posts']),'parent cannot withdraw school posts')
check(rpc('parents_calendar',s1['id'],today)['events'][0]['id']==event['id'],'calendar returns events for the requested month')
check(rpc('parents_calendar',s1['id'],today+timedelta(days=365))['events']==[],'calendar excludes other months')
for table in ['parent_students','parent_guardians','parent_posts','parent_messages']:
    denied(lambda table=table:c.execute('delete from '+table),'42501','direct table writes denied: '+table)
c.execute('select id from parent_students');check([str(r[0]) for r in c.fetchall()]==[s1['id']],'RLS protects direct student reads')
c.execute('select id from parent_posts');check(private['id'] not in [str(r[0]) for r in c.fetchall()],'RLS protects direct private diary reads')
denied(lambda:rpc('parents_feed',s2['id']),'42501','parent cannot read an unlinked classmate')
denied(lambda:rpc('parents_thread',s2['id']),'42501','parent cannot read an unlinked conversation')
denied(lambda:rpc('parents_send_message',s2['id'],'Hello'),'42501','parent cannot message about an unlinked child')
denied(lambda:rpc('parents_link_guardian',{**link,'student_id':s2['id']}),'42501','parent cannot link themselves to another child')
denied(lambda:rpc('parents_publish',{'class_id':ca['id'],'kind':'notice','title':'No','body':'No'}),'42501','parent cannot publish school updates')
denied(lambda:rpc('parents_unpublish',shared['id']),'42501','parent cannot withdraw homework')
denied(lambda:rpc('parents_send_message',s1['id'],'  '),'23514','blank messages rejected at database boundary')
rpc('parents_send_message',s1['id'],'How was their day?')
check(rpc('parents_thread',s1['id'])['messages'][0]['is_own'],'parent authorship comes from identity')
login('teacher');rpc('parents_send_message',s1['id'],'A happy day!')
login('parent');check(len(rpc('parents_thread',s1['id'])['messages'])==2,'family and teacher share a child conversation')
login('unlinked');check(rpc('parents_workspace')['students']==[],'center membership alone grants no child access')
login('owner')
for i in range(23):rpc('parents_publish',{'class_id':ca['id'],'kind':'notice','title':str(i),'body':'Pagination fixture'})
login('parent');one=rpc('parents_feed',s1['id'],'all',1);two=rpc('parents_feed',s1['id'],'all',2)
check(len(one['posts'])==20 and len(two['posts'])==5,'feed paginates without dropping entries')
check(not set(p['id'] for p in one['posts'])&set(p['id'] for p in two['posts']),'stable pages do not overlap')
login('owner');rpc('parents_unpublish',shared['id'])
login('parent');check(rpc('parents_feed',s1['id'],'homework')['total']==0,'withdrawn homework disappears')
login('owner');rpc('parents_link_guardian',{**link,'is_active':False})
login('parent');denied(lambda:rpc('parents_feed',s1['id']),'42501','revoking child link takes effect immediately')
login('owner');rpc('parents_link_guardian',link)
c.execute('reset role');c.execute('update user_memberships set expires_at=now()-interval \'1 day\' where user_id=%s',(users['parent'],))
login('parent');check(rpc('parents_workspace')['students']==[],'expired parent membership removes child access')
c.execute('reset role');c.execute('update user_memberships set expires_at=null where user_id=%s',(users['parent'],));c.execute('update profiles set is_active=false where id=%s',(users['parent'],))
login('parent');denied(lambda:rpc('parents_feed',s1['id']),'42501','suspension blocks existing parent identity')
c.execute('reset role');c.execute('update profiles set is_active=true where id=%s',(users['parent'],));c.execute('update parent_students set is_active=false where id=%s',(s1['id'],))
login('parent');check(rpc('parents_workspace')['students']==[],'inactive child is hidden from parents')
c.execute('reset role');c.execute('update teacher_assignments set ends_on=current_date-1 where id=%s',(assignment['id'],))
login('teacher');check(rpc('parents_workspace')['students']==[],'expired teacher assignment removes child access')
c.execute('reset role');c.execute('set role anon')
check(rpc('parents_readiness')['ready'] is True,'anonymous readiness verifies parent schema without exposing data')
denied(lambda:rpc('parents_workspace'),'42501','anonymous workspace access denied')
denied(lambda:rpc('parents_feed',s1['id']),'42501','anonymous feed access denied')
c.execute('reset role');c.execute("select count(*) from audit_events where event_type like 'parents.%'");check(c.fetchone()[0]>0,'administrative changes are audited')
print(f'{checks} parent database checks passed')
db.close()
