"""Rehearse a backup conversion with synthetic data in a disposable local test database."""
import os
import runpy
import sqlite3
from datetime import date
from pathlib import Path
from tempfile import TemporaryDirectory
from uuid import uuid4

import bcrypt
import psycopg2
from PIL import Image
from psycopg2.extensions import parse_dsn
from fastapi.testclient import TestClient

from api.config import Settings, get_settings
from api.main import app
from scripts.import_postgres_backup import prepare

dsn = os.environ['TEST_DATABASE_URL']
params = parse_dsn(dsn)
assert params.get('host') in {'127.0.0.1', 'localhost'} and params.get('dbname', '').startswith('test_')
fixture = runpy.run_path(str(Path(__file__).with_name('parents-database-regressions.py')))
owner, branch, classroom = fixture['users']['owner'], fixture['a'], fixture['ca']['id']


def main():
    with psycopg2.connect(dsn) as source, source.cursor() as cursor:
        cursor.execute('alter table auth.users add column encrypted_password text')
        password = bcrypt.hashpw(b'migration-test-password', bcrypt.gensalt(rounds=4)).decode()
        cursor.execute('update auth.users set encrypted_password=%s where id=%s',(password,owner))
        category, location, item, album, photo = [str(uuid4()) for _ in range(5)]
        cursor.execute("insert into inventory_categories(id,branch_id,name,code,created_by) values(%s,%s,'Test Books','BK',%s)",(category,branch,owner))
        cursor.execute("insert into inventory_locations(id,branch_id,name,code,created_by) values(%s,%s,'Test Store','ST',%s)",(location,branch,owner))
        cursor.execute("insert into inventory_items(id,branch_id,category_id,name,sku,standard_cost,created_by) values(%s,%s,%s,'Fixture books','BOOK',9.95,%s)",(item,branch,category,owner))
        cursor.execute("select set_config('request.jwt.claim.sub',%s,false)",(owner,))
        cursor.execute("""select * from post_inventory_movement(%s,%s,%s,'receipt',10.125,9.95,null,null,'fixture-receipt')""",(branch,item,location))
        movement = str(cursor.fetchone()[0])
        cursor.execute("""insert into parent_albums(id,branch_id,class_id,title,taken_on,status,created_by)
            values(%s,%s,%s,'Test album',%s,'published',%s)""",(album,branch,classroom,date.today(),owner))
        cursor.execute("""insert into parent_photos(id,album_id,caption,checksum,status,created_by,width,height)
            values(%s,%s,'Fixture image',%s,'ready',%s,80,60)""",(photo,album,'0'*64,owner))
    with TemporaryDirectory() as base:
        tmp=Path(base)
        snapshot=tmp/'data.db'
        try:
            prepare(dsn,snapshot)
        except ValueError as exc:
            assert 'photo' in str(exc).lower() and not snapshot.exists()
        else:
            raise AssertionError('Import must fail when a published photo is missing')
        media=tmp/'objects'/album/photo
        media.mkdir(parents=True)
        Image.new('RGB',(80,60),'pink').save(media/'full.jpg')
        report=prepare(dsn,snapshot,tmp/'objects')
        assert report['photos_imported']==1 and report['table_counts']['inventory_movements']==1
        with sqlite3.connect(snapshot) as database:
            assert database.execute('pragma integrity_check').fetchone()==('ok',)
            assert database.execute('select quantity_on_hand,average_unit_cost from inventory_stock_balances').fetchone()==(10125,995)
            assert database.execute('select count(*) from auth_sessions').fetchone()==(0,)
        settings=Settings(_env_file=None,sqlite_path=str(snapshot))
        app.dependency_overrides[get_settings]=lambda:settings
        try:
            with TestClient(app) as client:
                auth=client.post('/api/v1/auth/token?grant_type=password',json={
                    'email':'owner@test.invalid','password':'migration-test-password'})
                assert auth.status_code==200,auth.text
                header={'Authorization':'Bearer '+auth.json()['access_token']}
                response=client.post('/api/v1/inventory/movements',headers=header,json={
                    'branch_id':branch,'item_id':item,'location_id':location,'movement_type':'receipt',
                    'quantity':'10.125','unit_cost':'9.95','idempotency_key':'fixture-receipt'})
                assert response.status_code==201 and response.json()['movement_id']==movement,response.text
                response=client.get(f'/api/v1/parents/photos/{photo}/image',headers=header)
                assert response.status_code==200 and response.headers['content-type']=='image/jpeg',response.status_code
        finally:
            app.dependency_overrides.clear()
    print('Backup rehearsal passed: records, exact stock and costs, historical retries, bcrypt sign-in, and private photo bytes.')


if __name__=='__main__':
    main()
