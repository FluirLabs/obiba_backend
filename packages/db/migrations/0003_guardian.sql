alter table ops.guardian_decisions add column uid text;
alter table ops.guardian_decisions add column usd numeric(39, 0) not null default 0;
create index guardian_decisions_by_uid on ops.guardian_decisions(uid, decided_at desc);
grant select on ops.guardian_decisions to obiba_guardian_ro;

grant update (guardian_sig, canonical, status, updated_at) on ops.prepared_ops to obiba_app;
