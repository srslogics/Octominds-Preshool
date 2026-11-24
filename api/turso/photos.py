"""Private albums and photo bytes in the same transactional datastore."""
import hashlib

from fastapi import HTTPException

from .access import forbidden, invalid
from .families import publish_target, require_child, scoped_children


def manage(access, album):
    return access.manage(album['branch_id']) or (album['created_by']==access.actor and access.teach(album['class_id']))


def matches_child(album, child):
    return child['class_id']==album['class_id'] and album['student_id'] in (None,child['id'])


def require_album(access, album_id, student_id=None):
    album = access.db.one('select * from parent_albums where id=?', (album_id,))
    if not album or album['status']=='withdrawn':
        forbidden('Album access is not assigned.')
    if student_id:
        visible = matches_child(album, require_child(access, student_id))
    else:
        visible = manage(access, album) or any(matches_child(album,s) for s in scoped_children(access, album['class_id']))
    if not visible or (album['status']!='published' and not manage(access,album)):
        forbidden('Album access is not assigned.')
    return album


def detail(access, p_album, p_student=None):
    album = require_album(access,p_album,p_student)
    allowed = manage(access,album)
    photos = access.db.all("""select id, caption, status, width, height from parent_photos where album_id=?
        and (status='ready' or (status='pending' and ?)) order by created_at,id""", (album['id'],allowed))
    return {**{k:v for k,v in album.items() if k!='created_by'}, 'can_manage': allowed, 'photos': photos}


def create_album(access, p_data):
    classroom = publish_target(access,p_data)
    album = access.db.insert('parent_albums', {**p_data,'branch_id':classroom['branch_id'],'created_by':access.actor})
    access.audit('parents.album_created','parent_album',album['id'],classroom['branch_id'])
    return album


def gallery(access, p_student=None, p_page=1, p_class=None):
    child = require_child(access,p_student) if p_student else None
    db = access.db
    if child:
        albums = db.all("""select * from parent_albums where class_id=? and (student_id is null or student_id=?)
            and status<>'withdrawn' order by taken_on desc,id desc""", (child['class_id'],p_student))
        albums = [a for a in albums if a['status']=='published' or manage(access,a)]
    else:
        if p_class and not access.teach(p_class):
            forbidden('Access is limited to the classes you teach or manage.')
        albums = db.all("""select a.*,trim(c.name||' '||c.section) class_name,s.full_name student_name
            from parent_albums a join school_classes c on c.id=a.class_id
            left join parent_students s on s.id=a.student_id
            where a.status<>'withdrawn' and (? is null or a.class_id=?)
            order by a.taken_on desc,a.id desc""", (p_class, p_class))
        albums = [a for a in albums if manage(access,a)]
    items = []
    for album in albums[(p_page-1)*12:p_page*12]:
        row = {k: v for k, v in album.items() if k != 'created_by'}
        items.append({**row, 'can_manage': manage(access, album), 'photos': []})
    if items:
        by_id = {item['id']: item for item in items}
        slots = ','.join('?' for _ in by_id)
        photos = db.all(f"""select album_id,id,caption,status,width,height from parent_photos
            where album_id in ({slots}) and status in ('ready','pending')
            order by created_at,id""", by_id)
        for photo in photos:
            album = by_id[photo.pop('album_id')]
            if photo['status'] == 'ready' or album['can_manage']:
                album['photos'].append(photo)
    return {'albums':items,'total':len(albums),'page':p_page,'page_size':12}


def upload(access, album_id, photo_id, full, thumb, width, height, caption):
    db = access.db
    album = require_album(access,album_id)
    if not manage(access,album) or album['status']!='draft':
        forbidden('Only the school team can upload to a draft album.')
    checksum = hashlib.sha256(full).hexdigest()
    photo = db.one('select * from parent_photos where id=?', (photo_id,))
    if photo:
        if photo['album_id']!=album_id or photo['checksum']!=checksum or photo['status']=='removed':
            raise HTTPException(409,'This upload identifier belongs to different photo content.')
        if photo['status']=='ready':
            return public_photo(photo)
    else:
        if db.scalar("select count(*) from parent_photos where album_id=? and status<>'removed'", (album_id,)) >= 12:
            invalid('An album can contain up to 12 photos.')
        photo = db.insert('parent_photos', {'id':photo_id,'album_id':album_id,'caption':caption,
                                           'checksum':checksum,'created_by':access.actor})
    for variant,value in [('full',full),('thumb',thumb)]:
        chunks = [(photo_id,variant,i//65536,value[i:i+65536]) for i in range(0,len(value),65536)]
        db.connection.executemany('insert into photo_chunks(photo_id,variant,part,content) values (?,?,?,?)', chunks)
    return public_photo(db.update('parent_photos',photo_id,{'status':'ready','width':width,'height':height}))


def public_photo(photo):
    return {k: photo[k] for k in ('id','album_id','status','caption','width','height')}


def image(access, photo_id, student_id, thumbnail):
    db = access.db
    photo=db.one("select * from parent_photos where id=? and status='ready'",(photo_id,))
    if not photo:
        forbidden('Photo access is not assigned.')
    require_album(access,photo['album_id'],student_id)
    chunks = db.all('select content from photo_chunks where photo_id=? and variant=? order by part',
                    (photo_id,'thumb' if thumbnail else 'full'))
    if not chunks:
        raise HTTPException(404,'Photo is unavailable.')
    return b''.join(chunk['content'] for chunk in chunks)


def command(access, p_album, p_action, p_photo=None):
    db = access.db
    album = db.one('select * from parent_albums where id=?', (p_album,))
    if not album or not manage(access,album):
        forbidden('Album administration access required.')
    if p_action=='publish':
        if album['status']=='published':
            return {'id':p_album}
        if album['status']!='draft' or not db.scalar("select 1 from parent_photos where album_id=? and status='ready'",(p_album,)):
            invalid('Add at least one photo before publishing.')
        if db.scalar("select 1 from parent_photos where album_id=? and status='pending'",(p_album,)):
            invalid('Finish or remove incomplete uploads before publishing.')
        db.update('parent_albums',p_album,{'status':'published'})
    elif p_action=='withdraw':
        db.update('parent_albums',p_album,{'status':'withdrawn'})
        db.execute('delete from photo_chunks where photo_id in (select id from parent_photos where album_id=?)',(p_album,))
    elif p_action=='remove_photo':
        db.execute("update parent_photos set status='removed' where id=? and album_id=?",(p_photo,p_album))
        db.execute('delete from photo_chunks where photo_id in (select id from parent_photos where id=? and album_id=?)',(p_photo,p_album))
        if album['status']=='published' and not db.scalar("select 1 from parent_photos where album_id=? and status='ready'",(p_album,)):
            db.update('parent_albums',p_album,{'status':'withdrawn'})
    else:
        invalid('Unknown album action.')
    access.audit(f'parents.album_{p_action}','parent_album',p_album,album['branch_id'])
    return {'id':p_album,'cleanup_pending':False}
