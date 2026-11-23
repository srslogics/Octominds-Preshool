create table if not exists student_guardian_contacts (
    student_id text not null primary key references parent_students(id) on delete cascade,
    full_name text not null,
    login text not null,
    relationship text not null
);

create table if not exists school_invitation_students (
    invitation_id text not null primary key references school_invitations(id) on delete cascade,
    student_id text not null references parent_students(id),
    relationship text not null
);

create index if not exists school_invitation_students_student on school_invitation_students(student_id);
