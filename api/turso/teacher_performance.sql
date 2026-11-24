create table if not exists teacher_observations (
    id text primary key not null,
    branch_id text not null references branches(id),
    teacher_id text not null references profiles(id),
    class_id text not null,
    observed_on text not null,
    feedback text not null check(length(trim(feedback)) between 1 and 2000),
    follow_up text not null default '' check(length(follow_up) <= 1000),
    created_by text not null references profiles(id),
    created_at text not null,
    foreign key(class_id, branch_id) references school_classes(id, branch_id)
);

create index if not exists teacher_observations_history
    on teacher_observations(branch_id, teacher_id, observed_on desc, created_at desc, id desc);

create index if not exists teacher_activity_audit
    on audit_events(actor_user_id, branch_id, event_type, entity_type, occurred_at);
