create table ops.email_deliveries (
  dedupe_key text primary key check (length(dedupe_key) between 3 and 200),
  uid text,
  kind text not null check (kind ~ '^[A-Z_]{3,40}$'),
  status text not null check (status in ('sending', 'sent', 'delivered', 'delayed', 'failed', 'dead', 'skipped', 'bounced', 'complained')),
  attempts integer not null default 1,
  provider_id text check (length(provider_id) <= 100),
  last_error text check (length(last_error) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create unique index email_deliveries_provider on ops.email_deliveries(provider_id) where provider_id is not null;
create index email_deliveries_attention on ops.email_deliveries(updated_at) where status in ('failed', 'dead', 'bounced', 'complained');
alter table ops.email_deliveries enable row level security;
create policy worker_all on ops.email_deliveries for all to obiba_worker using (true) with check (true);
create policy ops_read on ops.email_deliveries for select to obiba_ops using (true);
grant select, insert, update on ops.email_deliveries to obiba_worker;
grant select on ops.email_deliveries to obiba_ops;

create table ops.email_suppressions (
  email_hash text primary key check (email_hash ~ '^[0-9a-f]{64}$'),
  reason text not null check (reason in ('bounce', 'complaint')),
  created_at timestamptz not null default now()
);
alter table ops.email_suppressions enable row level security;
create policy worker_read on ops.email_suppressions for select to obiba_worker using (true);
create policy ops_read on ops.email_suppressions for select to obiba_ops using (true);
grant select on ops.email_suppressions to obiba_worker, obiba_ops;

create function ops.record_email_event(p_provider_id text, p_status text, p_email_hash text)
returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if p_status not in ('delivered', 'delayed', 'bounced', 'complained') or length(p_provider_id) > 100 then
    raise exception 'invalid email event';
  end if;
  update ops.email_deliveries
     set status = p_status, updated_at = now()
   where provider_id = p_provider_id
     and status not in ('bounced', 'complained')
     and not (status = 'delivered' and p_status = 'delayed');
  if p_status in ('bounced', 'complained') and p_email_hash ~ '^[0-9a-f]{64}$' then
    insert into ops.email_suppressions(email_hash, reason)
    values (p_email_hash, case p_status when 'bounced' then 'bounce' else 'complaint' end)
    on conflict (email_hash) do nothing;
  end if;
end;
$$;
revoke all on function ops.record_email_event(text, text, text) from public;
grant execute on function ops.record_email_event(text, text, text) to obiba_app;

create table ops.password_reset_watches (
  uid text primary key,
  email text not null check (length(email) <= 254),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table ops.password_reset_watches enable row level security;
create policy worker_all on ops.password_reset_watches for all to obiba_worker using (true) with check (true);
grant select, insert, update, delete on ops.password_reset_watches to obiba_worker;

create table identity.known_clients (
  uid text not null references identity.users(uid),
  fingerprint text not null check (fingerprint ~ '^[0-9a-f]{64}$'),
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (uid, fingerprint)
);
alter table identity.known_clients enable row level security;
create policy app_own on identity.known_clients for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
grant select, insert on identity.known_clients to obiba_app;
grant update (last_seen_at) on identity.known_clients to obiba_app;
