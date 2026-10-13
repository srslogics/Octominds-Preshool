"""Integration checks against a NEW disposable local PostgreSQL database.

Requires psycopg2-binary and TEST_DATABASE_URL pointing to an empty test_* DB.
Emulates Supabase auth.uid(); never run against a Supabase/production database.
"""
import os
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from pathlib import Path
from uuid import uuid4

import psycopg2
from psycopg2.extensions import parse_dsn

dsn = os.environ["TEST_DATABASE_URL"]
params = parse_dsn(dsn)
assert params.get("host") in {"127.0.0.1", "localhost"}, "Local test database only"
assert params.get("dbname", "").startswith("test_"), "Use a disposable test_* database"
root = Path(__file__).resolve().parents[1]
db = psycopg2.connect(dsn)
db.autocommit = True
c = db.cursor()
c.execute("SELECT to_regclass('public.profiles')")
assert c.fetchone()[0] is None, "Database must be empty"
c.execute("""
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY, email text, phone text, raw_user_meta_data jsonb DEFAULT '{}');
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, anon;
""")
for name in ["202608160001_phase_1_foundation.sql", "202608290001_inventory_production.sql",
             "202609010001_inventory_center_setup.sql", "202610110001_inventory_access_hardening.sql",
             "202610110002_inventory_stock_integrity.sql", "202610130001_inventory_reporting.sql"]:
    c.execute((root / "supabase/migrations" / name).read_text())

branch, other, category, item, location = [str(uuid4()) for _ in range(5)]
users = {role: str(uuid4()) for role in ["super_admin", "branch_admin", "accountant", "teacher", "parent"]}
for role, user in users.items():
    c.execute("INSERT INTO auth.users(id,email) VALUES(%s,%s)", (user, role + '@test.invalid'))
c.execute("INSERT INTO branches(id,name,code) VALUES(%s,'Test A','A'),(%s,'Test B','B')", (branch, other))
for role, user in users.items():
    c.execute("INSERT INTO user_memberships(user_id,branch_id,role) VALUES(%s,%s,%s)", (user, branch, role))
c.execute("INSERT INTO inventory_categories(id,branch_id,name,code,created_by) VALUES(%s,%s,'Books','BK',%s)", (category, branch, users['super_admin']))
c.execute("INSERT INTO inventory_locations(id,branch_id,name,code,created_by) VALUES(%s,%s,'Store','ST',%s)", (location, branch, users['super_admin']))
c.execute("INSERT INTO inventory_items(id,branch_id,category_id,name,sku,created_by) VALUES(%s,%s,%s,'Books','BK-1',%s)", (item, branch, category, users['super_admin']))

def login(role):
    c.execute('RESET ROLE')
    c.execute("SELECT set_config('request.jwt.claim.sub',%s,false)", (users[role],))
    c.execute('SET ROLE authenticated')

checks = 0
def check(condition, label):
    global checks
    assert condition, label
    checks += 1
    print('PASS:', label)

def denied(sql, values, label):
    try:
        c.execute(sql, values)
    except psycopg2.errors.InsufficientPrivilege:
        check(True, label)
    else:
        raise AssertionError(label)

for role in ['teacher', 'parent']:
    login(role)
    c.execute('SELECT id FROM inventory_items')
    check(c.fetchall() == [], role + ' cannot read inventory directly')
login('accountant')
c.execute('SELECT has_inventory_access(%s,false),has_inventory_access(%s,true),has_inventory_access(%s,false)', (branch, branch, other))
check(c.fetchone() == (True, False, False), 'accountant read-only and scoped')
login('branch_admin')
c.execute('SELECT has_inventory_access(%s,true),has_inventory_access(%s,true)', (branch, other))
check(c.fetchone() == (True, False), 'branch admin write access remains scoped')
c.execute('RESET ROLE')
c.execute('UPDATE profiles SET is_active=false WHERE id=%s', (users['branch_admin'],))
login('branch_admin')
denied('UPDATE profiles SET is_active=true WHERE id=auth.uid()', (), 'disabled user cannot reactivate themselves')
c.execute('SELECT has_inventory_access(%s,true)', (branch,))
check(c.fetchone() == (False,), 'disabled user remains blocked')
login('super_admin')
c.execute("UPDATE profiles SET full_name='Updated name' WHERE id=auth.uid() RETURNING full_name")
check(c.fetchone() == ('Updated name',), 'safe self-profile update still works')
denied("INSERT INTO audit_events(actor_user_id,event_type) VALUES(auth.uid(),'forged')", (), 'client cannot forge audit events')
c.execute("SELECT * FROM post_inventory_movement(%s,%s,%s,'receipt',10,5,NULL,NULL,'hardening-test')", (branch,item,location))
check(c.fetchone()[1] == 10, 'trusted movement command still succeeds')
c.execute('RESET ROLE')
c.execute("SELECT count(*) FROM audit_events WHERE event_type='inventory.movement_posted'")
check(c.fetchone()[0] == 1, 'trusted command still writes audit event')
login('super_admin')

def rejected(sql, values, marker):
    try:
        c.execute(sql, values)
    except psycopg2.Error as error:
        check(marker in str(error), marker)
    else:
        raise AssertionError(marker + ' was not rejected')

rejected("UPDATE inventory_items SET unit='box' WHERE id=%s", (item,), 'inventory_unit_has_history')
rejected('UPDATE inventory_items SET is_active=false WHERE id=%s', (item,), 'inventory_item_has_stock')
c.execute("SELECT * FROM post_inventory_movement(%s,%s,%s,'receipt',10,5,NULL,NULL,'hardening-test')", (branch,item,location))
check(c.fetchone()[1] == 10, 'identical retry returns original balance without duplication')
rejected("SELECT * FROM post_inventory_movement(%s,%s,%s,'receipt',9,5,NULL,NULL,'hardening-test')", (branch,item,location), 'inventory_idempotency_conflict')
rejected("SELECT * FROM post_inventory_movement(%s,%s,%s,'receipt',1,'NaN',NULL,NULL,'nan-cost-test')", (branch,item,location), 'invalid_inventory_cost')
c.execute("SELECT * FROM post_inventory_movement(%s,%s,%s,'issue',10,NULL,NULL,NULL,'drain-test')", (branch,item,location))
check(c.fetchone()[1] == 0, 'issue still reduces balance correctly')
rejected("SELECT * FROM post_inventory_movement(%s,%s,%s,'opening_balance',1,NULL,NULL,NULL,'reopen-test')", (branch,item,location), 'opening_balance_already_exists')
rejected("UPDATE inventory_items SET unit='box' WHERE id=%s", (item,), 'inventory_unit_has_history')
c.execute('UPDATE inventory_items SET is_active=false WHERE id=%s RETURNING is_active', (item,))
check(c.fetchone() == (False,), 'zero-stock item may be archived')
c.execute('UPDATE inventory_items SET is_active=true WHERE id=%s', (item,))
c.execute("SELECT * FROM post_inventory_movement(%s,%s,%s,'receipt',5,5,NULL,NULL,'refill-test')", (branch,item,location))
destination = str(uuid4())
c.execute("INSERT INTO inventory_locations(id,branch_id,name,code) VALUES(%s,%s,'Second store','S2')", (destination,branch))
transfer = 'SELECT * FROM transfer_inventory_stock(%s,%s,%s,%s,2,NULL,NULL,%s)'
c.execute(transfer, (branch,item,location,destination,'transfer-test'))
original_transfer = c.fetchone()
check(original_transfer[1:] == (3,2), 'transfer conserves quantity')
c.execute(transfer, (branch,item,location,destination,'transfer-test'))
check(c.fetchone() == original_transfer, 'transfer retry returns original result')
rejected('SELECT * FROM transfer_inventory_stock(%s,%s,%s,%s,1,NULL,NULL,%s)', (branch,item,location,destination,'transfer-test'), 'inventory_idempotency_conflict')
c.execute("SELECT * FROM post_inventory_movement(%s,%s,%s,'issue',2,NULL,NULL,NULL,'drain-to-one')", (branch,item,location))
barrier = Barrier(2)
def simultaneous_retry():
    con = psycopg2.connect(dsn)
    con.autocommit = True
    try:
        cur = con.cursor()
        cur.execute("SELECT set_config('request.jwt.claim.sub',%s,false)", (users['super_admin'],))
        cur.execute('SET ROLE authenticated')
        barrier.wait(timeout=5)
        cur.execute("SELECT * FROM post_inventory_movement(%s,%s,%s,'issue',1,NULL,NULL,NULL,'concurrent-retry')", (branch,item,location))
        return cur.fetchone()
    finally:
        con.close()
with ThreadPoolExecutor(max_workers=2) as pool:
    first, second = pool.submit(simultaneous_retry), pool.submit(simultaneous_retry)
    check(first.result(timeout=10) == second.result(timeout=10), 'concurrent same-key issue returns the same result')
c.execute('SELECT quantity_on_hand FROM inventory_stock_balances WHERE item_id=%s AND location_id=%s', (item,location))
check(c.fetchone() == (0,), 'concurrent retries deduct stock once')
c.execute('RESET ROLE')
c.execute('UPDATE branches SET is_active=false WHERE id=%s', (branch,))
login('super_admin')
denied("SELECT * FROM post_inventory_movement(%s,%s,%s,'receipt',1,5,NULL,NULL,'inactive-test')", (branch,item,location), 'inactive center blocks stock commands')
c.execute('SELECT id FROM inventory_items')
check(c.fetchall() == [], 'inactive center data is not exposed')
# Reporting must count/filter the entire catalogue, not the gateway row limit.
c.execute('RESET ROLE')
c.execute('UPDATE branches SET is_active=true WHERE id=%s', (branch,))
c.execute("INSERT INTO inventory_items(branch_id,category_id,name,sku,created_by) SELECT %s,%s,'Bulk '||n,'BULK-'||n,%s FROM generate_series(1,5100) n", (branch, category, users['super_admin']))
login('super_admin')
c.execute('SELECT inventory_read_dashboard(%s)', (branch,))
check(c.fetchone()[0]['active_items'] == 5101, 'dashboard counts more than 5000 items')
c.execute("SELECT inventory_read_items(%s,'BULK-5100','out',1,25)", (branch,))
report = c.fetchone()[0]
check(report['total'] == 1 and report['items'][0]['sku'] == 'BULK-5100', 'search and stock filter find items beyond gateway cap')
c.execute("SELECT inventory_read_items(%s,'Bulk','out',51,100)", (branch,))
report = c.fetchone()[0]
check(report['total'] == 5100 and len(report['items']) == 100, 'deep pagination reports exact total')
login('teacher')
c.execute('SELECT inventory_read_dashboard(%s)', (branch,))
check(c.fetchone()[0]['active_items'] == 0, 'reporting RPC preserves role RLS')
login('accountant')
c.execute('SELECT inventory_read_dashboard(%s)', (other,))
check(c.fetchone()[0]['active_items'] == 0, 'reporting RPC preserves center isolation')
c.execute('RESET ROLE')
# Place movements on both sides of local midnight and compare to the same local date.
# Local fixture setup only: production movements remain immutable.
c.execute('ALTER TABLE inventory_movements DISABLE TRIGGER inventory_movements_immutable')
c.execute("UPDATE branches SET timezone='Asia/Kolkata' WHERE id=%s", (branch,))
c.execute("UPDATE inventory_movements SET posted_at=(date_trunc('day',now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')-interval '1 minute' WHERE branch_id=%s", (branch,))
c.execute("UPDATE inventory_movements SET posted_at=(date_trunc('day',now() at time zone 'Asia/Kolkata') at time zone 'Asia/Kolkata')+interval '1 minute' WHERE id=(SELECT id FROM inventory_movements WHERE branch_id=%s LIMIT 1)", (branch,))
c.execute('ALTER TABLE inventory_movements ENABLE TRIGGER inventory_movements_immutable')
login('super_admin')
c.execute('SELECT inventory_read_dashboard(%s)', (branch,))
check(c.fetchone()[0]['movements_today'] == 1, 'today uses center-local midnight')
c.execute('RESET ROLE')
c.execute('SET ROLE anon')
c.execute('SELECT inventory_readiness()')
check(c.fetchone()[0]['ready'] is True, 'anonymous readiness exposes migration state only')
denied('SELECT inventory_read_items()', (), 'anonymous catalogue RPC denied')
db.close()
print(f'{checks} security and stock-integrity regression checks passed')
