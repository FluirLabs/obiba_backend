alter table identity.devices add column kind text not null default 'browser' check (kind in ('browser', 'passkey'));
alter table identity.devices add column label text check (length(label) <= 80);

alter table ops.account_calls drop constraint account_calls_method_check;
alter table ops.account_calls add constraint account_calls_method_check
  check (method in ('set_limit', 'add_token', 'add_device', 'remove_device'));
grant update (args_b64) on ops.account_calls to obiba_app;

create table identity.webauthn_users (
  uid text primary key references identity.users(uid),
  handle text not null unique check (handle ~ '^[A-Za-z0-9_-]{22}$'),
  created_at timestamptz not null default now()
);
alter table identity.webauthn_users enable row level security;
create policy app_own on identity.webauthn_users for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
grant select, insert on identity.webauthn_users to obiba_app;

create table identity.passkeys (
  id uuid primary key default gen_random_uuid(),
  uid text not null references identity.users(uid),
  credential_id text not null unique check (credential_id ~ '^[A-Za-z0-9_-]{16,1366}$'),
  public_key text not null check (public_key ~ '^[A-Za-z0-9_-]{20,2000}$'),
  counter bigint not null default 0 check (counter >= 0),
  transports text[] not null default '{}',
  aaguid text check (aaguid ~ '^[0-9a-f-]{36}$'),
  backed_up boolean not null default false,
  device_public_key text not null unique references identity.devices(public_key),
  wrapped_key text check (wrapped_key ~ '^[A-Za-z0-9+/]{64}$'),
  wrap_iv text check (wrap_iv ~ '^[A-Za-z0-9+/]{16}$'),
  prf_salt text not null check (prf_salt ~ '^[A-Za-z0-9_-]{43}$'),
  label text check (length(label) <= 80),
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  check (status = 'revoked' or (wrapped_key is not null and wrap_iv is not null)),
  check (status <> 'revoked' or (wrapped_key is null and wrap_iv is null and revoked_at is not null))
);
create index passkeys_by_uid on identity.passkeys(uid, created_at);
alter table identity.passkeys enable row level security;
create policy app_own on identity.passkeys for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy worker_all on identity.passkeys for all to obiba_worker using (true) with check (true);
grant select on identity.passkeys to obiba_app;
grant insert (uid, credential_id, public_key, counter, transports, aaguid, backed_up, device_public_key, wrapped_key, wrap_iv, prf_salt, label) on identity.passkeys to obiba_app;
grant update (counter, last_used_at) on identity.passkeys to obiba_app;
grant select on identity.passkeys to obiba_worker;
grant update (status, wrapped_key, wrap_iv, revoked_at) on identity.passkeys to obiba_worker;

create table ops.device_links (
  id uuid primary key default gen_random_uuid(),
  uid text not null references identity.users(uid),
  new_public_key text not null references identity.devices(public_key),
  code text not null check (code ~ '^[0-9]{2}$'),
  label text check (length(label) <= 80),
  status text not null default 'PENDING' check (status in ('PENDING', 'APPROVED', 'DENIED', 'COMPLETED', 'FAILED', 'EXPIRED', 'CANCELLED')),
  call_id text references ops.account_calls(call_id),
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  check (status <> 'APPROVED' or call_id is not null)
);
create unique index device_links_one_open on ops.device_links(uid) where status in ('PENDING', 'APPROVED');
alter table ops.device_links enable row level security;
create policy app_own on ops.device_links for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy worker_all on ops.device_links for all to obiba_worker using (true) with check (true);
grant select on ops.device_links to obiba_app;
grant insert (uid, new_public_key, code, label, expires_at) on ops.device_links to obiba_app;
grant update (status, call_id, decided_at) on ops.device_links to obiba_app;
grant select on ops.device_links to obiba_worker;
grant update (status) on ops.device_links to obiba_worker;

create table ops.device_grants (
  call_id text primary key references ops.account_calls(call_id),
  uid text not null references identity.users(uid),
  public_key text not null check (public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  kind text not null check (kind in ('passkey_enroll', 'passkey_signin', 'device_link', 'device_remove')),
  ref text not null check (length(ref) between 1 and 1400),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table ops.device_grants enable row level security;
create policy app_own on ops.device_grants for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy guardian_read on ops.device_grants for select to obiba_guardian_ro using (true);
create policy worker_read on ops.device_grants for select to obiba_worker using (true);
grant select, insert on ops.device_grants to obiba_app;
grant select on ops.device_grants to obiba_guardian_ro, obiba_worker;
