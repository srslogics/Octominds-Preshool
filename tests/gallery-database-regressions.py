"""Run against an EMPTY local test_* DB. Includes the 50 parent foundation checks."""
import os
import runpy
from pathlib import Path
from uuid import uuid4
import psycopg2
from psycopg2.extras import Json

state=runpy.run_path(str(Path(__file__).with_name('parents-database-regressions.py')))
users,a,b,ca,cb,s1,s2,s3=[state[k] for k in ['users','a','b','ca','cb','s1','s2','s3']]
db=psycopg2.connect(os.environ['TEST_DATABASE_URL']);db.autocommit=True;c=db.cursor();checks=0
c.execute('update profiles set is_active=true')
c.execute('update parent_students set is_active=true')
c.execute('update user_memberships set expires_at=null')
c.execute("update teacher_assignments set ends_on=current_date+10 where id=%s",(state['assignment']['id'],))
# Emulate permissive legacy policies; gallery restrictions must still win.
c.execute('create policy legacy_all on storage.objects for all to authenticated using(true) with check(true)')
c.execute('create policy legacy_anon on storage.objects for all to anon using(true) with check(true)')

def login(name):
 c.execute('reset role');c.execute("select set_config('request.jwt.claim.sub',%s,false)",(users[name],));c.execute('set role authenticated')
def check(value,label):
 global checks
 assert value,label;checks+=1;print('PASS:',label)
def rpc(name,*args):
 c.execute('select '+name+'('+','.join(['%s']*len(args))+')',tuple(Json(v) if isinstance(v,dict) else v for v in args));return c.fetchone()[0]
def denied(fn,code,label):
 try:fn()
 except psycopg2.Error as e:check(e.pgcode==code,label)
 else:raise AssertionError(label+' was allowed')
def create(target=None):
 return rpc('parents_create_album',{'class_id':ca['id'],'student_id':target,'title':'A school day','description':'Our discoveries','taken_on':'2026-11-21'})
def paths(album,photo):return [f'{album["id"]}/{photo}/full.jpg',f'{album["id"]}/{photo}/thumb.jpg']
def upload(album,photo):
 rpc('parents_prepare_photo',album['id'],photo,'a'*64,'A little moment')
 for path in paths(album,photo):c.execute("insert into storage.objects(bucket_id,name,metadata) values('octominds-parent-photos',%s,%s)",(path,Json({'mimetype':'image/jpeg','size':1000})))
 return rpc('parents_finish_photo',album['id'],photo,640,480)

login('teacher');album=create();photo=str(uuid4())
check(album['status']=='draft','new album remains private draft')
login('parent');check(rpc('parents_staff_albums')['total']==0,'parents have no staff album list');check(rpc('parents_gallery',s1['id'])['total']==0,'parent cannot see draft albums')
denied(lambda:rpc('parents_create_album',{'class_id':ca['id'],'title':'No','taken_on':'2026-11-21'}),'42501','parent cannot create albums')
login('other_teacher');denied(lambda:create(),'42501','unassigned teacher cannot create albums')
login('teacher')
denied(lambda:rpc('parents_create_album',{'class_id':cb['id'],'title':'No','taken_on':'2026-11-21'}),'42501','teacher cannot create cross-center albums')
denied(lambda:create(s3['id']),'22023','private album child must belong to class')
denied(lambda:rpc('parents_album_command',album['id'],'publish'),'22023','empty albums cannot publish')
p=rpc('parents_prepare_photo',album['id'],photo,'a'*64,'Leaf play')
check(rpc('parents_prepare_photo',album['id'],photo,'a'*64,'Leaf play')['id']==p['id'],'repeated reservation reuses photo identifier')
denied(lambda:rpc('parents_prepare_photo',album['id'],photo,'b'*64,'Changed'),'40001','retry identifier cannot switch image content')
c.execute("insert into storage.objects(bucket_id,name) values('octominds-parent-photos',%s)",(paths(album,photo)[0],))
denied(lambda:rpc('parents_finish_photo',album['id'],photo,640,480),'22023','photo cannot finish without thumbnail')
denied(lambda:rpc('parents_album_command',album['id'],'publish'),'22023','incomplete photo cannot publish')
c.execute("insert into storage.objects(bucket_id,name) values('octominds-parent-photos',%s)",(paths(album,photo)[1],))
rpc('parents_finish_photo',album['id'],photo,640,480)
login('parent');c.execute("select count(*) from storage.objects where bucket_id='octominds-parent-photos'");check(c.fetchone()[0]==0,'Storage hides unpublished files despite broad legacy policy')
login('teacher');rpc('parents_album_command',album['id'],'publish');check(rpc('parents_album_command',album['id'],'publish')['id']==album['id'],'publish retry succeeds without duplicating an album');c.execute("delete from storage.objects where name=any(%s)",(paths(album,photo),));check(c.rowcount==0,'staff cannot delete files before hiding the photo')
login('parent');gallery=rpc('parents_gallery',s1['id']);check(gallery['total']==1 and len(gallery['albums'][0]['photos'])==1,'linked family sees published album and photo metadata')
check(not gallery['albums'][0]['can_manage'],'parents receive no gallery management capability')
check(rpc('parents_photo_access',photo,s1['id'])['path'].endswith(photo),'photo proxy authorizes the selected child')
denied(lambda:rpc('parents_photo_access',photo,s2['id']),'42501','cannot spoof selected child to obtain photo')
denied(lambda:rpc('parents_album_command',album['id'],'withdraw'),'42501','parent cannot withdraw album')
denied(lambda:rpc('parents_album_command',album['id'],'remove_photo',photo),'42501','parent cannot remove a photo')
c.execute("select count(*) from storage.objects where bucket_id='octominds-parent-photos'");check(c.fetchone()[0]==2,'linked family reads published private storage objects')
denied(lambda:c.execute("insert into storage.objects(bucket_id,name) values('octominds-parent-photos','forged.jpg')"),'42501','parent cannot insert files despite broad legacy policy')
c.execute("update storage.objects set metadata='{}' where bucket_id='octominds-parent-photos'");check(c.rowcount==0,'published photos cannot be overwritten despite broad legacy policy')
c.execute("delete from storage.objects where bucket_id='octominds-parent-photos'");check(c.rowcount==0,'parent cannot delete private storage objects')
for table in ['parent_albums','parent_photos']:denied(lambda table=table:c.execute('delete from '+table),'42501','direct metadata mutation denied: '+table)
login('unlinked');check(rpc('parents_workspace')['students']==[],'unlinked membership does not grant gallery children')
c.execute("select count(*) from storage.objects where bucket_id='octominds-parent-photos'");check(c.fetchone()[0]==0,'unlinked parent cannot read raw storage objects')
denied(lambda:rpc('parents_photo_access',photo),'42501','unlinked parent cannot bypass child parameter')
login('teacher');private=create(s2['id']);private_photo=str(uuid4());upload(private,private_photo);rpc('parents_album_command',private['id'],'publish')
login('parent');check(rpc('parents_gallery',s1['id'])['total']==1,'classmate private album is excluded')
denied(lambda:rpc('parents_photo_access',private_photo,s1['id']),'42501','private classmate photo is not readable')
login('teacher');draft=create();draft_id=str(uuid4());upload(draft,draft_id)
login('admin');check(rpc('parents_album_detail',draft['id'])['can_manage'],'center administrator can resume teacher draft');check(any(a['id']==draft['id'] for a in rpc('parents_staff_albums')['albums']),'staff can find drafts outside the selected child gallery')
login('teacher');cap=create()
for _ in range(12):rpc('parents_prepare_photo',cap['id'],str(uuid4()),'c'*64,'')
denied(lambda:rpc('parents_prepare_photo',cap['id'],str(uuid4()),'c'*64,''),'22023','album photo count enforced in database')
rpc('parents_album_command',album['id'],'remove_photo',photo)
login('parent');denied(lambda:rpc('parents_photo_access',photo,s1['id']),'42501','removing last photo immediately hides its album and image')
c.execute("select count(*) from storage.objects where name=%s",(paths(album,photo)[0],));check(c.fetchone()[0]==0,'removed object is unreadable before physical cleanup')
login('teacher');check(any(x['id']==album['id'] for x in rpc('parents_photo_cleanup_list')['albums']),'school team can find interrupted physical removals');check(len(rpc('parents_album_command',album['id'],'cleanup')['paths'])==2,'cleanup retries only target hidden photos');c.execute("delete from storage.objects where name=any(%s)",(paths(album,photo),));check(c.rowcount==2,'authorized staff can physically clean removed images')
rpc('parents_album_command',draft['id'],'withdraw')
denied(lambda:rpc('parents_photo_access',draft_id),'42501','withdrawal blocks staff image reads too')
login('owner');rpc('parents_link_guardian',{'student_id':s1['id'],'user_id':users['parent'],'relationship':'Guardian','is_active':False})
login('parent');denied(lambda:rpc('parents_gallery',s1['id']),'42501','child link revocation removes gallery access immediately')
c.execute('reset role');c.execute('set role anon')
c.execute("select count(*) from storage.objects where bucket_id='octominds-parent-photos'");check(c.fetchone()[0]==0,'anonymous legacy policy cannot expose gallery bucket')
denied(lambda:rpc('parents_album_detail',private['id']),'42501','anonymous album RPC denied')
check(rpc('parents_gallery_readiness')['ready'],'gallery readiness verifies private bucket and migration chain')
c.execute('reset role');c.execute("select count(*) from audit_events where event_type like 'parents.album_%'");check(c.fetchone()[0]>0,'gallery administrative changes are audited')
print(f'{checks} gallery database checks passed (plus 50 parent checks)');db.close()
