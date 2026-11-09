create table ops.support_cases (
  id uuid primary key default gen_random_uuid(),
  uid text not null references identity.users(uid),
  account_id text not null references chain.accounts(account_id),
  new_public_key text not null check (new_public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  status text not null default 'OPEN' check (status in ('OPEN', 'VERIFIED', 'APPROVED', 'SUBMITTED', 'REJECTED', 'CANCELLED')),
  checks jsonb not null default '{}'::jsonb,
  notes text check (length(notes) <= 2000),
  verified_by text,
  verified_at timestamptz,
  approved_by text,
  approved_at timestamptz,
  closed_by text,
  closed_reason text check (length(closed_reason) <= 500),
  recovery_id uuid references ops.recoveries(id),
  new_phone_e164 text check (new_phone_e164 ~ '^\+233[0-9]{9}$'),
  source text not null default 'app' check (source in ('app', 'email_link')),
  status_token_hash text check (status_token_hash ~ '^[0-9a-f]{64}$'),
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (approved_by is null or (verified_by is not null and approved_by <> verified_by)),
  check (status not in ('VERIFIED', 'APPROVED', 'SUBMITTED') or verified_by is not null),
  check (status not in ('APPROVED', 'SUBMITTED') or approved_by is not null)
);
create unique index support_cases_one_open on ops.support_cases(uid) where status in ('OPEN', 'VERIFIED', 'APPROVED');
create index support_cases_queue on ops.support_cases(created_at) where status in ('OPEN', 'VERIFIED', 'APPROVED');

alter table ops.support_cases enable row level security;
create policy app_own on ops.support_cases for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy ops_all on ops.support_cases for all to obiba_ops using (true) with check (true);
create policy guardian_read on ops.support_cases for select to obiba_guardian_ro using (true);
create policy worker_read on ops.support_cases for select to obiba_worker using (true);
grant select on ops.support_cases to obiba_app;
grant insert (uid, account_id, new_public_key) on ops.support_cases to obiba_app;
grant update (status, closed_by, closed_reason, updated_at) on ops.support_cases to obiba_app;

create function ops.support_case_app_guard() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if current_user = 'obiba_app' or exists (
    select 1 from pg_auth_members m join pg_roles g on g.oid = m.roleid join pg_roles u on u.oid = m.member
     where g.rolname = 'obiba_app' and u.rolname = current_user
  ) then
    if new.status <> 'CANCELLED' or old.status not in ('OPEN', 'VERIFIED', 'APPROVED') then
      raise exception 'the account holder can only cancel an open support case';
    end if;
  end if;
  return new;
end;
$$;
create trigger support_case_app_guard before update on ops.support_cases for each row execute function ops.support_case_app_guard();
grant select on ops.support_cases to obiba_ops, obiba_guardian_ro, obiba_worker;
grant update (status, checks, notes, verified_by, verified_at, approved_by, approved_at, closed_by, closed_reason, recovery_id, activated_at, updated_at) on ops.support_cases to obiba_ops;
grant update (phone_e164, phone_verified_at) on identity.users to obiba_ops;

create table ops.support_links (
  token_hash text primary key check (token_hash ~ '^[0-9a-f]{64}$'),
  uid text not null references identity.users(uid),
  new_phone_e164 text not null check (new_phone_e164 ~ '^\+233[0-9]{9}$'),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index support_links_by_uid on ops.support_links(uid, created_at desc);
alter table ops.support_links enable row level security;
create policy ops_read on ops.support_links for select to obiba_ops using (true);
grant select on ops.support_links to obiba_ops;

create function ops.create_support_link(p_email text, p_token_hash text, p_token text, p_new_phone text)
returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_uid text;
  v_recent integer;
begin
  if p_token_hash !~ '^[0-9a-f]{64}$' or p_token !~ '^[A-Za-z0-9_-]{43}$' or p_new_phone !~ '^\+233[0-9]{9}$' then
    raise exception 'invalid support link request';
  end if;
  select u.uid into v_uid
    from identity.users u join chain.accounts a on a.uid = u.uid
   where lower(u.email) = lower(p_email) and u.status = 'active' and a.status in ('active', 'frozen');
  if v_uid is null then return; end if;
  select count(*) into v_recent from ops.support_links where uid = v_uid and created_at > now() - interval '1 hour';
  if v_recent >= 3 then return; end if;
  insert into ops.support_links(token_hash, uid, new_phone_e164, expires_at) values (p_token_hash, v_uid, p_new_phone, now() + interval '30 minutes');
  insert into infra.outbox(topic, payload) values ('notify.email', jsonb_build_object('uid', v_uid, 'kind', 'SUPPORT_LINK', 'ref', null, 'token', p_token));
end;
$$;

create function ops.peek_support_link(p_token_hash text)
returns table(uid text, display_name text, expires_at timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select l.uid, u.display_name, l.expires_at
    from ops.support_links l join identity.users u on u.uid = l.uid
   where l.token_hash = p_token_hash and l.used_at is null and l.expires_at > now();
$$;

create function ops.redeem_support_link(p_token_hash text, p_new_public_key text, p_status_hash text)
returns table(case_id uuid, uid text, created_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_link ops.support_links;
  v_account text;
  v_case uuid;
  v_created timestamptz;
begin
  if p_new_public_key !~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$' or p_status_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid support link redemption';
  end if;
  select * into v_link from ops.support_links l where l.token_hash = p_token_hash and l.used_at is null and l.expires_at > now() for update;
  if v_link.token_hash is null then return; end if;
  select a.account_id into v_account from chain.accounts a where a.uid = v_link.uid and a.status in ('active', 'frozen');
  if v_account is null then return; end if;
  if exists (select 1 from ops.recoveries r where r.uid = v_link.uid and r.status in ('REQUESTED', 'SIGNED', 'SUBMITTED', 'PENDING_TIMELOCK', 'CANCEL_REQUESTED')) then
    raise exception 'a recovery is already in progress' using errcode = '23505';
  end if;
  update ops.support_links set used_at = now() where token_hash = p_token_hash;
  insert into identity.devices(uid, public_key, initial, status) values (v_link.uid, p_new_public_key, false, 'pending');
  insert into ops.support_cases(uid, account_id, new_public_key, new_phone_e164, source, status_token_hash)
       values (v_link.uid, v_account, p_new_public_key, v_link.new_phone_e164, 'email_link', p_status_hash)
    returning id, ops.support_cases.created_at into v_case, v_created;
  insert into ops.notifications(uid, kind, ref) values (v_link.uid, 'SUPPORT_CASE_OPENED', v_case::text) on conflict do nothing;
  insert into infra.outbox(topic, payload) values ('notify.email', jsonb_build_object('uid', v_link.uid, 'kind', 'SUPPORT_CASE_OPENED', 'ref', v_case::text));
  return query select v_case, v_link.uid, v_created;
end;
$$;

create function ops.support_request_status(p_case_id uuid, p_status_hash text)
returns table(status text, created_at timestamptz, closed_reason text, activated_at timestamptz, recovery_status text, executable_at timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select s.status, s.created_at, case when s.status = 'REJECTED' then s.closed_reason end, s.activated_at, r.status, r.executable_at
    from ops.support_cases s left join ops.recoveries r on r.id = s.recovery_id
   where s.id = p_case_id and s.status_token_hash = p_status_hash;
$$;

revoke all on function ops.create_support_link(text, text, text, text), ops.peek_support_link(text), ops.redeem_support_link(text, text, text), ops.support_request_status(uuid, text) from public;
grant execute on function ops.create_support_link(text, text, text, text), ops.peek_support_link(text), ops.redeem_support_link(text, text, text), ops.support_request_status(uuid, text) to obiba_app;

alter table ops.recoveries drop constraint if exists recoveries_method_check;
alter table ops.recoveries add constraint recoveries_method_check check (method in ('TOTP', 'KIT', 'SMS', 'SUPPORT'));
alter table ops.recoveries add column support_case_id uuid references ops.support_cases(id);
alter table ops.recoveries add constraint recoveries_support_case check ((method = 'SUPPORT') = (support_case_id is not null));

create policy ops_write on ops.recoveries for insert to obiba_ops with check (method = 'SUPPORT');
create policy ops_update on ops.recoveries for update to obiba_ops using (method = 'SUPPORT') with check (method = 'SUPPORT');
grant insert (uid, account_id, new_public_key, status, method, support_case_id) on ops.recoveries to obiba_ops;
grant update (status, guardian_sig, guardian_nonce, reason, updated_at) on ops.recoveries to obiba_ops;

create policy ops_write on identity.devices for update to obiba_ops using (status = 'pending') with check (status in ('pending', 'revoked'));
grant update (status) on identity.devices to obiba_ops;

