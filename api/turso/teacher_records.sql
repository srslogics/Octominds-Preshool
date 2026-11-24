create table if not exists student_daily_records (
    id text not null primary key,
    student_id text not null references parent_students(id) on delete cascade,
    school_day text not null,
    details text not null,
    version integer not null default 1,
    updated_at text not null,
    unique(student_id, school_day)
);

create table if not exists class_meal_plans (
    id text not null primary key,
    class_id text not null references school_classes(id) on delete cascade,
    school_day text not null,
    details text not null,
    version integer not null default 1,
    updated_at text not null,
    unique(class_id, school_day)
);

create table if not exists student_family_profiles (
    id text not null primary key,
    student_id text not null unique references parent_students(id) on delete cascade,
    details text not null,
    version integer not null default 1,
    updated_at text not null
);
