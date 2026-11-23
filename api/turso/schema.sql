-- OctoMinds libSQL schema. Stock quantities are integer thousandths and costs are integer cents.

create table if not exists accounts (
 id text not null primary key, email text not null unique collate nocase, password_hash text,
 email_confirmed_at text, failed_attempts integer not null default 0, locked_until integer not null default 0
);
create table if not exists auth_sessions (
 token_hash text not null primary key, refresh_hash text not null unique,
 user_id text not null references accounts(id) on delete cascade, expires_at integer not null, refresh_expires_at integer not null
);
create index if not exists auth_sessions_user on auth_sessions(user_id);
create table if not exists auth_recovery (
 token_hash text not null primary key, user_id text not null references accounts(id) on delete cascade,
 purpose text not null check(purpose in ('confirm','recover')), expires_at integer not null
);
create index if not exists auth_recovery_user on auth_recovery(user_id,purpose);
create table if not exists app_schema (version integer primary key);
insert or ignore into app_schema(version) values(1);

create table if not exists branches (
  id text not null primary key,
  name text not null,
  code text not null unique,
  address text,
  phone text,
  timezone text not null default 'Asia/Kolkata',
  is_active integer not null default true,
  created_at text not null default CURRENT_TIMESTAMP,
  updated_at text not null default CURRENT_TIMESTAMP,
 email text, opens_at text, closes_at text, working_days text not null default '[1,2,3,4,5]', capacity integer check(capacity>=0), version integer not null default 1, check(opens_at is null or closes_at is null or closes_at>opens_at)
);

create table if not exists profiles (
  id text not null primary key references accounts(id) on delete cascade,
  full_name text not null,
  phone text,
  avatar_path text,
  is_active integer not null default true,
  created_at text not null default CURRENT_TIMESTAMP,
  updated_at text not null default CURRENT_TIMESTAMP
);

create table if not exists user_memberships (
  id text not null primary key,
  user_id text not null references profiles(id) on delete cascade,
  branch_id text references branches(id) on delete cascade,
  role text not null check(role in ('super_admin','management','branch_admin','teacher','admission_counsellor','accountant','parent')),
  is_active integer not null default true,
  created_at text not null default CURRENT_TIMESTAMP,
  updated_at text not null default CURRENT_TIMESTAMP,
  expires_at text,
  constraint branch_required_for_scoped_roles check (
    role in ('super_admin', 'management') or branch_id is not null
  )
);

create table if not exists audit_events (
  id text not null primary key,
  actor_user_id text references profiles(id) on delete set null,
  branch_id text references branches(id) on delete set null,
  event_type text not null,
  entity_type text,
  entity_id text,
  request_id text,
  metadata text not null default '{}',
  occurred_at text not null default CURRENT_TIMESTAMP
);

create table if not exists inventory_categories (
  id text not null primary key,
  branch_id text not null references branches(id) on delete restrict,
  name text not null,
  code text not null,
  description text,
  is_active integer not null default true,
  created_by text not null references profiles(id) on delete restrict,
  created_at text not null default CURRENT_TIMESTAMP,
  updated_at text not null default CURRENT_TIMESTAMP,
  constraint inventory_categories_name_present check (length(trim(name)) between 2 and 80),
  unique (branch_id, code),
  unique (id, branch_id)
);

create table if not exists inventory_locations (
  id text not null primary key,
  branch_id text not null references branches(id) on delete restrict,
  name text not null,
  code text not null,
  location_type text not null default 'branch_store',
  is_active integer not null default true,
  created_by text not null references profiles(id) on delete restrict,
  created_at text not null default CURRENT_TIMESTAMP,
  updated_at text not null default CURRENT_TIMESTAMP,
  constraint inventory_locations_name_present check (length(trim(name)) between 2 and 80),
  constraint inventory_locations_type_allowed check (location_type in ('central_store', 'branch_store', 'classroom', 'daycare', 'office')),
  unique (branch_id, code),
  unique (id, branch_id)
);

create table if not exists inventory_items (
  id text not null primary key,
  branch_id text not null references branches(id) on delete restrict,
  category_id text not null,
  name text not null,
  sku text not null,
  description text,
  unit text not null default 'piece',
  reorder_level integer not null default 0,
  standard_cost integer,
  is_active integer not null default true,
  created_by text not null references profiles(id) on delete restrict,
  created_at text not null default CURRENT_TIMESTAMP,
  updated_at text not null default CURRENT_TIMESTAMP,
  constraint inventory_items_name_present check (length(trim(name)) between 2 and 120),
  constraint inventory_items_unit_allowed check (unit in ('piece', 'packet', 'box', 'set', 'litre', 'kilogram', 'metre', 'roll')),
  constraint inventory_items_reorder_nonnegative check (reorder_level >= 0),
  constraint inventory_items_cost_nonnegative check (standard_cost is null or standard_cost >= 0),
  unique (branch_id, sku),
  unique (id, branch_id),
  constraint inventory_item_category_branch_fk foreign key (category_id, branch_id)
    references inventory_categories(id, branch_id) on delete restrict
);

create table if not exists inventory_stock_balances (
  branch_id text not null references branches(id) on delete restrict,
  location_id text not null,
  item_id text not null,
  quantity_on_hand integer not null default 0,
  average_unit_cost integer,
  version integer not null default 0,
  updated_at text not null default CURRENT_TIMESTAMP,
  primary key (location_id, item_id),
  constraint inventory_stock_nonnegative check (quantity_on_hand >= 0),
  constraint inventory_average_cost_nonnegative check (average_unit_cost is null or average_unit_cost >= 0),
  constraint inventory_balance_location_branch_fk foreign key (location_id, branch_id)
    references inventory_locations(id, branch_id) on delete restrict,
  constraint inventory_balance_item_branch_fk foreign key (item_id, branch_id)
    references inventory_items(id, branch_id) on delete restrict
);

create table if not exists inventory_movements (
  id text not null primary key,
  branch_id text not null references branches(id) on delete restrict,
  item_id text not null,
  location_id text not null,
  movement_type text not null,
  quantity integer not null,
  signed_quantity integer not null,
  quantity_before integer not null,
  quantity_after integer not null,
  unit_cost integer,
  reference text,
  notes text,
  transfer_group_id text,
  idempotency_key text,
  posted_by text not null references profiles(id) on delete restrict,
  posted_at text not null default CURRENT_TIMESTAMP,
  constraint inventory_movement_quantity_positive check (quantity > 0),
  constraint inventory_movement_result_nonnegative check (quantity_after >= 0),
  constraint inventory_movement_cost_nonnegative check (unit_cost is null or unit_cost >= 0),
  constraint inventory_movement_reference_length check (reference is null or length(reference) <= 80),
  constraint inventory_movement_notes_length check (notes is null or length(notes) <= 500),
  constraint inventory_movement_item_branch_fk foreign key (item_id, branch_id)
    references inventory_items(id, branch_id) on delete restrict,
  constraint inventory_movement_location_branch_fk foreign key (location_id, branch_id)
    references inventory_locations(id, branch_id) on delete restrict
);

create table if not exists school_settings (
 id text not null primary key, singleton integer not null default true unique check(singleton),
 name text not null check(length(trim(name)) between 1 and 120),
 email text, phone text, address text, website text,
 version integer not null default 1, updated_at text not null default CURRENT_TIMESTAMP
);

create table if not exists academic_years (
 id text not null primary key, branch_id text not null references branches(id),
 name text not null check(length(trim(name)) between 1 and 120), starts_on text not null, ends_on text not null,
 status text not null default 'planned' check(status in ('planned','active','closed')),
 version integer not null default 1, updated_at text not null default CURRENT_TIMESTAMP,
 check(ends_on>=starts_on), unique(branch_id,name), unique(id,branch_id)
);

create table if not exists school_terms (
 id text not null primary key, branch_id text not null references branches(id),
 academic_year_id text not null, name text not null check(length(trim(name)) between 1 and 120),
 starts_on text not null, ends_on text not null, version integer not null default 1, updated_at text not null default CURRENT_TIMESTAMP,
 check(ends_on>=starts_on), unique(academic_year_id,name),
 foreign key(academic_year_id,branch_id) references academic_years(id,branch_id)
);

create table if not exists school_programs (
 id text not null primary key, branch_id text not null references branches(id),
 name text not null check(length(trim(name)) between 1 and 120), description text,
 is_active integer not null default true, version integer not null default 1, updated_at text not null default CURRENT_TIMESTAMP,
 unique(branch_id,name), unique(id,branch_id)
);

create table if not exists school_classes (
 id text not null primary key, branch_id text not null references branches(id),
 academic_year_id text not null, program_id text not null,
 name text not null check(length(trim(name)) between 1 and 120), section text not null default '',
 room text, capacity integer not null check(capacity between 1 and 1000), is_active integer not null default true,
 version integer not null default 1, updated_at text not null default CURRENT_TIMESTAMP,
 foreign key(academic_year_id,branch_id) references academic_years(id,branch_id),
 foreign key(program_id,branch_id) references school_programs(id,branch_id),
 unique(academic_year_id,program_id,name,section), unique(id,branch_id)
);

create table if not exists teacher_assignments (
 id text not null primary key, branch_id text not null references branches(id),
 class_id text not null, user_id text not null references profiles(id), starts_on text not null,
 ends_on text, is_active integer not null default true, version integer not null default 1, updated_at text not null default CURRENT_TIMESTAMP,
 check(ends_on is null or ends_on>=starts_on), foreign key(class_id,branch_id) references school_classes(id,branch_id)
);

create table if not exists school_holidays (
 id text not null primary key, branch_id text not null references branches(id),
 name text not null check(length(trim(name)) between 1 and 120), starts_on text not null, ends_on text not null,
 is_active integer not null default true, version integer not null default 1, updated_at text not null default CURRENT_TIMESTAMP,
 check(ends_on>=starts_on)
);

create table if not exists school_invitations (
 id text not null primary key, email text not null, full_name text not null,
 branch_id text references branches(id), role text not null, token_hash text not null unique,
 expires_at text not null, membership_expires_at text,
 created_by text not null references profiles(id), created_at text not null default CURRENT_TIMESTAMP,
 accepted_by text references profiles(id), accepted_at text, revoked_at text,
 check(role in ('super_admin','management') or branch_id is not null)
);

create table if not exists parent_students (
 id text not null primary key, branch_id text not null references branches(id),
 class_id text not null, full_name text not null check(length(trim(full_name)) between 1 and 120),
 is_active integer not null default true, version integer not null default 1,
 created_at text not null default CURRENT_TIMESTAMP, updated_at text not null default CURRENT_TIMESTAMP,
 foreign key(class_id,branch_id) references school_classes(id,branch_id)
);

create table if not exists parent_guardians (
 id text not null primary key, student_id text not null references parent_students(id),
 user_id text not null references profiles(id), relationship text not null check(length(trim(relationship)) between 1 and 40),
 is_active integer not null default true, unique(student_id,user_id)
);

create table if not exists parent_posts (
 id text not null primary key, branch_id text not null references branches(id),
 class_id text not null, student_id text references parent_students(id),
 kind text not null check(kind in ('notice','homework','diary','event')),
 title text not null check(length(trim(title)) between 1 and 160),
 body text not null check(length(trim(body)) between 1 and 10000), event_date text,
 is_published integer not null default true, created_by text not null references profiles(id),
 created_at text not null default CURRENT_TIMESTAMP,
 check((kind='event')=(event_date is not null)),
 foreign key(class_id,branch_id) references school_classes(id,branch_id)
);

create table if not exists parent_messages (
 id text not null primary key, student_id text not null references parent_students(id),
 author_id text not null references profiles(id), body text not null check(length(trim(body)) between 1 and 2000),
 created_at text not null default CURRENT_TIMESTAMP
);

create table if not exists parent_albums (
 id text not null primary key, branch_id text not null references branches(id),
 class_id text not null, student_id text references parent_students(id),
 title text not null check(length(trim(title)) between 1 and 160),
 description text not null default '' check(length(description)<=2000), taken_on text not null,
 status text not null default 'draft' check(status in ('draft','published','withdrawn')),
 created_by text not null references profiles(id), created_at text not null default CURRENT_TIMESTAMP,
 foreign key(class_id,branch_id) references school_classes(id,branch_id)
);

create table if not exists parent_photos (
 id text not null primary key, album_id text not null references parent_albums(id),
 caption text not null default '' check(length(caption)<=200),
 checksum text not null check(length(checksum) = 64 and checksum not glob '*[^0-9a-f]*'),
 status text not null default 'pending' check(status in ('pending','ready','removed')),
 created_by text not null references profiles(id), created_at text not null default CURRENT_TIMESTAMP,
 width integer, height integer, check(width between 1 and 2048), check(height between 1 and 2048)
);

create unique index if not exists memberships_active_scope on user_memberships(user_id,role,coalesce(branch_id,'')) where is_active=1;
create unique index if not exists academic_year_active on academic_years(branch_id) where status='active';
create unique index if not exists teacher_assignment_active on teacher_assignments(class_id,user_id) where is_active=1;
create unique index if not exists movement_idempotency on inventory_movements(posted_by,idempotency_key) where idempotency_key is not null;
create index if not exists movements_center_date on inventory_movements(branch_id,posted_at,id);
create index if not exists balances_item on inventory_stock_balances(item_id);
create index if not exists items_active_center on inventory_items(branch_id,is_active,name);
create index if not exists parent_guardians_by_user on parent_guardians(user_id,student_id) where is_active=1;
create index if not exists parent_posts_by_class on parent_posts(class_id,created_at,id);
create index if not exists parent_messages_by_student on parent_messages(student_id,created_at,id);
create index if not exists parent_students_by_class on parent_students(class_id);
create index if not exists parent_albums_by_class on parent_albums(class_id,taken_on,id);
create index if not exists parent_photos_by_album on parent_photos(album_id,created_at,id);
create table if not exists inventory_commands (
 actor_id text not null references profiles(id), command_key text not null,
 operation text not null, payload text not null, result text not null, primary key(actor_id,command_key)
);
create table if not exists photo_chunks (
 photo_id text not null references parent_photos(id) on delete cascade,
 variant text not null check(variant in ('full','thumb')), part integer not null,
 content blob not null check(length(content) between 1 and 65536), primary key(photo_id,variant,part)
);
