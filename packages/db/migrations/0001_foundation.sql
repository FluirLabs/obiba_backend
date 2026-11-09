do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'obiba_app') then create role obiba_app nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'obiba_worker') then create role obiba_worker nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'obiba_indexer') then create role obiba_indexer nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'obiba_guardian_ro') then create role obiba_guardian_ro nologin; end if;
  if not exists (select 1 from pg_roles where rolname = 'obiba_ops') then create role obiba_ops nologin; end if;
end $$;

revoke create on schema public from public;

create schema identity;
create schema chain;
create schema ops;
create schema ledger;
create schema audit;
create schema infra;

revoke all on schema identity, chain, ops, ledger, audit, infra from public;
alter default privileges revoke execute on functions from public;

create function infra.reject_mutation() returns trigger
language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'append-only table %.% cannot be modified (%)', tg_table_schema, tg_table_name, tg_op
    using errcode = 'insufficient_privilege';
end $$;

create table identity.users (
  uid text primary key check (uid ~ '^[A-Za-z0-9_-]{6,128}$'),
  display_name text not null check (length(display_name) between 1 and 120),
  phone_e164 text not null check (phone_e164 ~ '^\+233[0-9]{9}$'),
  email text not null check (length(email) between 3 and 254),
  handle text unique check (handle ~ '^[a-z0-9_]{3,24}$'),
  status text not null default 'active' check (status in ('active', 'disabled')),
  pilot_allowed boolean not null default false,
  merchant boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table identity.devices (
  id uuid primary key default gen_random_uuid(),
  uid text not null references identity.users(uid),
  public_key text not null unique check (public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  initial boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'active', 'revoked')),
  created_at timestamptz not null default now()
);
create unique index devices_one_initial on identity.devices(uid) where initial;

create table chain.accounts (
  account_id text primary key check (account_id ~ '^u-[a-z0-9]{10}\.[a-z0-9.-]+$'),
  uid text not null unique references identity.users(uid),
  status text not null default 'provisioning' check (status in ('provisioning', 'active', 'quarantined', 'frozen')),
  created_at timestamptz not null default now()
);

create table chain.events (
  receipt_id text not null check (length(receipt_id) between 32 and 64),
  log_index integer not null check (log_index >= 0),
  block_height bigint not null,
  kind text not null,
  token text not null,
  from_account text not null,
  to_account text not null,
  amount numeric(39, 0) not null check (amount > 0),
  tx_hash text,
  raw jsonb not null,
  observed_at timestamptz not null default now(),
  primary key (receipt_id, log_index)
);
create trigger events_append_only before update or delete on chain.events
  for each statement execute function infra.reject_mutation();

create table chain.cursor (
  stream text primary key,
  block_height bigint not null check (block_height >= 0)
);

create type ledger.domain as enum ('REAL', 'DEMO');

create table ledger.accounts (
  id bigserial primary key,
  domain ledger.domain not null,
  kind text not null check (kind in ('WALLET', 'EXTERNAL', 'TREASURY', 'CLEARING', 'DEMO_USER', 'DEMO_FAUCET', 'DEMO_PROVIDER')),
  ref text not null check (length(ref) between 1 and 200),
  currency text not null check (currency ~ '^[A-Z0-9_]{2,16}$'),
  unique (domain, ref, currency),
  check ((domain = 'DEMO') = (kind like 'DEMO\_%'))
);

create table ledger.balances (
  account_id bigint primary key references ledger.accounts(id),
  kind text not null,
  posted numeric(39, 0) not null default 0,
  held numeric(39, 0) not null default 0 check (held >= 0),
  check (kind not in ('WALLET', 'DEMO_USER') or posted - held >= 0)
);

create table ledger.journals (
  id bigserial primary key,
  domain ledger.domain not null,
  op_ref text not null unique check (length(op_ref) between 3 and 200),
  kind text not null check (length(kind) between 1 and 64),
  source jsonb,
  created_at timestamptz not null default now()
);

create table ledger.entries (
  id bigserial primary key,
  journal_id bigint not null references ledger.journals(id),
  account_id bigint not null references ledger.accounts(id),
  amount numeric(39, 0) not null check (amount <> 0),
  currency text not null
);
create index entries_by_account on ledger.entries(account_id, journal_id);

create table ledger.holds (
  op_ref text primary key check (length(op_ref) between 3 and 200),
  account_id bigint not null references ledger.accounts(id),
  amount numeric(39, 0) not null check (amount > 0),
  status text not null check (status in ('ACTIVE', 'CAPTURED', 'RELEASED')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  closed_at timestamptz
);

create trigger journals_append_only before update or delete on ledger.journals
  for each statement execute function infra.reject_mutation();
create trigger entries_append_only before update or delete on ledger.entries
  for each statement execute function infra.reject_mutation();
create trigger journals_no_truncate before truncate on ledger.journals
  for each statement execute function infra.reject_mutation();
create trigger entries_no_truncate before truncate on ledger.entries
  for each statement execute function infra.reject_mutation();

create function ledger.check_entry() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  j_domain ledger.domain;
  a_domain ledger.domain;
  a_currency text;
begin
  select domain into j_domain from ledger.journals where id = new.journal_id;
  select domain, currency into a_domain, a_currency from ledger.accounts where id = new.account_id;
  if j_domain is distinct from a_domain then
    raise exception 'entry account domain % does not match journal domain %', a_domain, j_domain;
  end if;
  if a_currency is distinct from new.currency then
    raise exception 'entry currency % does not match account currency %', new.currency, a_currency;
  end if;
  return new;
end $$;
create trigger entries_check before insert on ledger.entries
  for each row execute function ledger.check_entry();

create function ledger.check_journal_balanced() returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  bad record;
  n integer;
begin
  select count(*) into n from ledger.entries where journal_id = new.journal_id;
  if n < 2 then
    raise exception 'journal % must have at least two entries', new.journal_id;
  end if;
  select currency, sum(amount) as total into bad
    from ledger.entries where journal_id = new.journal_id
    group by currency having sum(amount) <> 0 limit 1;
  if found then
    raise exception 'journal % is unbalanced in % by %', new.journal_id, bad.currency, bad.total;
  end if;
  return null;
end $$;
create constraint trigger entries_balanced after insert on ledger.entries
  deferrable initially deferred
  for each row execute function ledger.check_journal_balanced();

create function ledger.ensure_account(p_domain ledger.domain, p_kind text, p_ref text, p_currency text)
returns bigint
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id bigint;
begin
  insert into ledger.accounts(domain, kind, ref, currency)
    values (p_domain, p_kind, p_ref, p_currency)
    on conflict (domain, ref, currency) do nothing
    returning id into v_id;
  if v_id is null then
    select id into v_id from ledger.accounts
      where domain = p_domain and ref = p_ref and currency = p_currency and kind = p_kind;
    if v_id is null then
      raise exception 'ledger account % exists with a different kind', p_ref;
    end if;
  else
    insert into ledger.balances(account_id, kind) values (v_id, p_kind);
  end if;
  return v_id;
end $$;

create function ledger.post_journal_internal(p_domain ledger.domain, p_op_ref text, p_kind text, p_entries jsonb, p_source jsonb)
returns bigint
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id bigint;
  v_existing jsonb;
  v_requested jsonb;
  e record;
begin
  if jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) < 2 or jsonb_array_length(p_entries) > 20 then
    raise exception 'journal needs between 2 and 20 entries';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('ledger:' || p_op_ref, 0));

  select coalesce(jsonb_agg(jsonb_build_object('account_id', x.account_id, 'amount', x.amount::text, 'currency', x.currency)
           order by x.account_id, x.amount, x.currency), '[]'::jsonb)
    into v_requested
    from jsonb_to_recordset(p_entries) as x(account_id bigint, amount numeric, currency text);

  select id into v_id from ledger.journals where op_ref = p_op_ref;
  if v_id is not null then
    select coalesce(jsonb_agg(jsonb_build_object('account_id', account_id, 'amount', amount::text, 'currency', currency)
             order by account_id, amount, currency), '[]'::jsonb)
      into v_existing from ledger.entries where journal_id = v_id;
    if v_existing <> v_requested or (select domain from ledger.journals where id = v_id) <> p_domain then
      raise exception 'op_ref % already posted with different entries', p_op_ref using errcode = 'unique_violation';
    end if;
    return v_id;
  end if;

  insert into ledger.journals(domain, op_ref, kind, source) values (p_domain, p_op_ref, p_kind, p_source)
    returning id into v_id;

  for e in
    select x.account_id, x.amount, x.currency
      from jsonb_to_recordset(p_entries) as x(account_id bigint, amount numeric, currency text)
      order by x.account_id
  loop
    if e.amount is null or e.amount = 0 or e.amount <> trunc(e.amount) then
      raise exception 'entry amounts must be non-zero integers';
    end if;
    insert into ledger.entries(journal_id, account_id, amount, currency) values (v_id, e.account_id, e.amount, e.currency);
    update ledger.balances set posted = posted + e.amount where account_id = e.account_id;
    if not found then
      raise exception 'ledger account % has no balance row', e.account_id;
    end if;
  end loop;
  return v_id;
end $$;

create function ledger.post_real_journal(p_op_ref text, p_kind text, p_entries jsonb, p_source jsonb)
returns bigint
language sql security definer set search_path = pg_catalog, pg_temp as $$
  select ledger.post_journal_internal('REAL', p_op_ref, p_kind, p_entries, p_source);
$$;

create function ledger.post_demo_journal(p_op_ref text, p_kind text, p_entries jsonb, p_source jsonb)
returns bigint
language sql security definer set search_path = pg_catalog, pg_temp as $$
  select ledger.post_journal_internal('DEMO', p_op_ref, p_kind, p_entries, p_source);
$$;

create function ledger.place_hold(p_op_ref text, p_account_id bigint, p_amount numeric, p_expires_at timestamptz)
returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  h ledger.holds;
  b ledger.balances;
begin
  if p_amount is null or p_amount <= 0 or p_amount <> trunc(p_amount) then
    raise exception 'hold amount must be a positive integer';
  end if;
  select * into b from ledger.balances where account_id = p_account_id for update;
  if not found then
    raise exception 'unknown ledger account %', p_account_id;
  end if;
  select * into h from ledger.holds where op_ref = p_op_ref;
  if found then
    if h.account_id = p_account_id and h.amount = p_amount then
      return;
    end if;
    raise exception 'hold % already exists with different parameters', p_op_ref using errcode = 'unique_violation';
  end if;
  if b.posted - b.held < p_amount then
    raise exception 'insufficient available balance' using errcode = 'check_violation';
  end if;
  insert into ledger.holds(op_ref, account_id, amount, status, expires_at)
    values (p_op_ref, p_account_id, p_amount, 'ACTIVE', p_expires_at);
  update ledger.balances set held = held + p_amount where account_id = p_account_id;
end $$;

create function ledger.close_hold(p_op_ref text, p_status text)
returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  h ledger.holds;
begin
  if p_status not in ('CAPTURED', 'RELEASED') then
    raise exception 'invalid hold status %', p_status;
  end if;
  select * into h from ledger.holds where op_ref = p_op_ref for update;
  if not found then
    raise exception 'unknown hold %', p_op_ref;
  end if;
  if h.status = p_status then
    return;
  end if;
  if h.status <> 'ACTIVE' then
    raise exception 'hold % is already %', p_op_ref, h.status;
  end if;
  perform 1 from ledger.balances where account_id = h.account_id for update;
  update ledger.holds set status = p_status, closed_at = now() where op_ref = p_op_ref;
  update ledger.balances set held = held - h.amount where account_id = h.account_id;
end $$;

create table ops.idempotency (
  uid text not null references identity.users(uid),
  key text not null check (key ~ '^[A-Za-z0-9_-]{16,64}$'),
  request_hash text not null check (length(request_hash) = 64),
  status text not null check (status in ('IN_PROGRESS', 'DONE')),
  response jsonb,
  created_at timestamptz not null default now(),
  primary key (uid, key)
);

create table ops.prepared_ops (
  op_id text primary key check (op_id ~ '^[0-9a-f]{32}$'),
  uid text not null references identity.users(uid),
  account_id text not null references chain.accounts(account_id),
  kind text not null check (kind in ('Transfer', 'PayInvoice')),
  receiver text not null,
  amount numeric(39, 0) not null check (amount > 0),
  expires_at_ns numeric(20, 0) not null,
  canonical jsonb not null,
  needs_guardian boolean not null,
  guardian_sig text,
  status text not null check (status in ('PREPARED', 'COSIGNED', 'SUBMITTED', 'RELAYED', 'SETTLED', 'EXPIRED', 'REJECTED', 'FAILED', 'UNKNOWN')),
  signed_delegate text,
  invoice_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index prepared_ops_by_uid on ops.prepared_ops(uid, created_at desc);

create table ops.deposits (
  id uuid primary key default gen_random_uuid(),
  uid text not null references identity.users(uid),
  account_id text not null references chain.accounts(account_id),
  origin_asset text not null,
  deposit_address text not null,
  deposit_memo text,
  amount_in text not null,
  min_amount_out numeric(39, 0) not null check (min_amount_out > 0),
  correlation_id text,
  quote jsonb not null,
  status text not null,
  credited_event jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (deposit_address, deposit_memo)
);
create unique index deposits_address_no_memo on ops.deposits(deposit_address) where deposit_memo is null;

create table ops.invoices (
  invoice_id text primary key check (invoice_id ~ '^[0-9a-f]{32}$'),
  merchant_uid text not null references identity.users(uid),
  merchant_account text not null references chain.accounts(account_id),
  token text not null check (length(token) between 2 and 64),
  amount numeric(39, 0) not null check (amount > 0),
  fee_bps integer not null check (fee_bps between 0 and 100),
  expires_at_ns numeric(20, 0) not null,
  reference text check (length(reference) <= 64),
  signature text not null,
  status text not null check (status in ('OPEN', 'PAYING', 'PAID', 'EXPIRED', 'CANCELLED')),
  created_at timestamptz not null default now()
);

create table ops.sandbox_ops (
  id uuid primary key default gen_random_uuid(),
  uid text not null references identity.users(uid),
  kind text not null check (kind in ('MOMO_FUND', 'BANK_FUND', 'AIRTIME', 'DATA', 'ECG', 'MOMO_PAYOUT')),
  provider text not null,
  target text not null,
  amount numeric(39, 0) not null check (amount > 0),
  status text not null check (status in ('CREATED', 'PENDING', 'SUCCEEDED', 'FAILED', 'REVIEW')),
  receipt jsonb,
  created_at timestamptz not null default now()
);

create table ops.guardian_decisions (
  id bigserial primary key,
  op_id text not null,
  outcome text not null check (outcome in ('SIGNED', 'REFUSED')),
  rules jsonb not null,
  decided_at timestamptz not null default now()
);
create trigger guardian_decisions_append_only before update or delete on ops.guardian_decisions
  for each statement execute function infra.reject_mutation();

create table audit.log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor text not null,
  action text not null check (length(action) between 1 and 64),
  target text,
  outcome text not null check (outcome in ('ALLOWED', 'DENIED', 'FAILED')),
  request_id text,
  details jsonb not null default '{}'::jsonb
);
create trigger audit_append_only before update or delete on audit.log
  for each statement execute function infra.reject_mutation();
create trigger audit_no_truncate before truncate on audit.log
  for each statement execute function infra.reject_mutation();

create table infra.outbox (
  id bigserial primary key,
  topic text not null check (length(topic) between 1 and 64),
  payload jsonb not null,
  created_at timestamptz not null default now(),
  dispatched_at timestamptz
);
create index outbox_pending on infra.outbox(id) where dispatched_at is null;

create function ops.current_uid() returns text
language sql stable set search_path = pg_catalog, pg_temp as $$
  select nullif(current_setting('obiba.uid', true), '');
$$;

alter table identity.users enable row level security;
alter table identity.devices enable row level security;
alter table chain.accounts enable row level security;
alter table ops.idempotency enable row level security;
alter table ops.prepared_ops enable row level security;
alter table ops.deposits enable row level security;
alter table ops.invoices enable row level security;
alter table ops.sandbox_ops enable row level security;

create policy app_own on identity.users for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy app_own on identity.devices for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy app_own on chain.accounts for select to obiba_app using (uid = ops.current_uid());
create policy app_own on ops.idempotency for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy app_own on ops.prepared_ops for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy app_own on ops.deposits for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy app_own on ops.invoices for all to obiba_app using (merchant_uid = ops.current_uid()) with check (merchant_uid = ops.current_uid());
create policy app_own on ops.sandbox_ops for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());

create policy worker_all on identity.users for select to obiba_worker using (true);
create policy worker_all on identity.devices for all to obiba_worker using (true) with check (true);
create policy worker_all on chain.accounts for all to obiba_worker using (true) with check (true);
create policy worker_all on ops.prepared_ops for all to obiba_worker using (true) with check (true);
create policy worker_all on ops.deposits for all to obiba_worker using (true) with check (true);
create policy worker_all on ops.invoices for all to obiba_worker using (true) with check (true);
create policy worker_all on ops.sandbox_ops for all to obiba_worker using (true) with check (true);

create policy guardian_read on identity.devices for select to obiba_guardian_ro using (true);
create policy guardian_read on chain.accounts for select to obiba_guardian_ro using (true);
create policy guardian_read on ops.prepared_ops for select to obiba_guardian_ro using (true);
create policy guardian_read on identity.users for select to obiba_guardian_ro using (true);

create policy ops_read on identity.users for select to obiba_ops using (true);
create policy ops_read on chain.accounts for select to obiba_ops using (true);
create policy ops_read on ops.prepared_ops for select to obiba_ops using (true);
create policy ops_read on ops.deposits for select to obiba_ops using (true);
create policy ops_read on ops.invoices for select to obiba_ops using (true);

create function ops.public_invoice(p_invoice_id text)
returns table(invoice_id text, merchant_name text, merchant_account text, token text, amount text, fee_bps integer, expires_at_ns text, status text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select i.invoice_id, u.display_name, i.merchant_account, i.token, i.amount::text, i.fee_bps, i.expires_at_ns::text, i.status
    from ops.invoices i join identity.users u on u.uid = i.merchant_uid
   where i.invoice_id = p_invoice_id and p_invoice_id ~ '^[0-9a-f]{32}$';
$$;

create function ops.invoice_for_payment(p_invoice_id text)
returns table(invoice_id text, merchant_name text, merchant_account text, token text, amount text, fee_bps integer, expires_at_ns text, reference text, signature text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select i.invoice_id, u.display_name, i.merchant_account, i.token, i.amount::text, i.fee_bps, i.expires_at_ns::text, i.reference, i.signature
    from ops.invoices i join identity.users u on u.uid = i.merchant_uid
   where i.invoice_id = p_invoice_id and p_invoice_id ~ '^[0-9a-f]{32}$' and i.status = 'OPEN'
     and ops.current_uid() is not null;
$$;

create function ops.resolve_recipient(p_handle text)
returns table(display_name text, account_id text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select u.display_name, a.account_id
    from identity.users u join chain.accounts a on a.uid = u.uid
   where u.handle = lower(p_handle) and u.status = 'active' and a.status = 'active'
     and ops.current_uid() is not null;
$$;

create function ledger.my_balances()
returns table(domain ledger.domain, currency text, posted text, held text, available text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select la.domain, la.currency, b.posted::text, b.held::text, (b.posted - b.held)::text
    from ledger.accounts la
    join ledger.balances b on b.account_id = la.id
   where (la.domain = 'REAL' and la.kind = 'WALLET'
          and la.ref = (select 'wallet:' || a.account_id from chain.accounts a where a.uid = ops.current_uid()))
      or (la.domain = 'DEMO' and la.kind = 'DEMO_USER' and la.ref = 'demo:' || ops.current_uid());
$$;

create function ledger.my_activity(p_limit integer, p_before bigint)
returns table(journal_id bigint, domain ledger.domain, kind text, op_ref text, amount text, currency text, created_at timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select j.id, j.domain, j.kind, j.op_ref, e.amount::text, e.currency, j.created_at
    from ledger.entries e
    join ledger.journals j on j.id = e.journal_id
    join ledger.accounts la on la.id = e.account_id
   where ((la.domain = 'REAL' and la.kind = 'WALLET'
           and la.ref = (select 'wallet:' || a.account_id from chain.accounts a where a.uid = ops.current_uid()))
       or (la.domain = 'DEMO' and la.kind = 'DEMO_USER' and la.ref = 'demo:' || ops.current_uid()))
     and (p_before is null or j.id < p_before)
   order by j.id desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
$$;

grant usage on schema identity, chain, ops, ledger, infra, audit to obiba_app, obiba_worker;
grant usage on schema chain, ledger, infra, audit to obiba_indexer;
grant usage on schema identity, chain, ops to obiba_guardian_ro;
grant usage on schema identity, chain, ops, ledger, audit, infra to obiba_ops;

grant select, insert, update on identity.users, identity.devices to obiba_app;
grant select on chain.accounts to obiba_app;
grant select, insert, update on ops.idempotency, ops.prepared_ops, ops.deposits, ops.invoices, ops.sandbox_ops to obiba_app;
grant delete on ops.idempotency to obiba_app;
grant insert on audit.log, infra.outbox to obiba_app;
grant usage on sequence audit.log_id_seq, infra.outbox_id_seq to obiba_app;
grant execute on function ops.current_uid(), ops.public_invoice(text), ops.resolve_recipient(text), ops.invoice_for_payment(text),
  ledger.my_balances(), ledger.my_activity(integer, bigint),
  ledger.ensure_account(ledger.domain, text, text, text),
  ledger.post_demo_journal(text, text, jsonb, jsonb),
  ledger.place_hold(text, bigint, numeric, timestamptz),
  ledger.close_hold(text, text) to obiba_app;

grant select on identity.users, identity.devices to obiba_worker;
grant update (status) on identity.devices to obiba_worker;
grant select, insert, update on chain.accounts to obiba_worker;
grant select, update on ops.prepared_ops, ops.deposits, ops.invoices, ops.sandbox_ops to obiba_worker;
grant select, update on infra.outbox to obiba_worker;
grant insert on audit.log to obiba_worker;
grant usage on sequence audit.log_id_seq to obiba_worker;
grant execute on function ops.current_uid(), ledger.ensure_account(ledger.domain, text, text, text),
  ledger.close_hold(text, text), ledger.post_demo_journal(text, text, jsonb, jsonb) to obiba_worker;

grant select, insert on chain.events to obiba_indexer;
grant select, insert, update on chain.cursor to obiba_indexer;
grant select on chain.accounts to obiba_indexer;
grant insert on infra.outbox to obiba_indexer;
grant usage on sequence infra.outbox_id_seq to obiba_indexer;
grant execute on function ledger.ensure_account(ledger.domain, text, text, text),
  ledger.post_real_journal(text, text, jsonb, jsonb) to obiba_indexer;

grant select on identity.users, identity.devices, chain.accounts, ops.prepared_ops to obiba_guardian_ro;
grant insert on ops.guardian_decisions to obiba_guardian_ro;
grant usage on sequence ops.guardian_decisions_id_seq to obiba_guardian_ro;
grant execute on function ops.current_uid() to obiba_guardian_ro;

grant select on all tables in schema identity, chain, ops, ledger, audit, infra to obiba_ops;
