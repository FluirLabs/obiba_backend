alter table ops.deposits add column tx_hashes jsonb not null default '{}'::jsonb;

create table ops.withdrawals (
  id uuid primary key default gen_random_uuid(),
  uid text not null references identity.users(uid),
  account_id text not null references chain.accounts(account_id),
  op_id text not null unique references ops.prepared_ops(op_id),
  destination text not null check (length(destination) between 2 and 32),
  recipient text not null check (length(recipient) between 2 and 100),
  deposit_address text not null unique check (length(deposit_address) between 2 and 64),
  amount_in numeric(39, 0) not null check (amount_in > 0),
  amount_out text not null,
  min_amount_out text not null,
  quote jsonb not null,
  status text not null check (status in ('PREPARED', 'SUBMITTED', 'SENT', 'PROCESSING', 'VERIFYING', 'COMPLETED', 'REFUNDED', 'FAILED', 'REVIEW_REQUIRED')),
  tx_hashes jsonb not null default '{}'::jsonb,
  evidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index withdrawals_by_uid on ops.withdrawals(uid, created_at desc);
create index withdrawals_active on ops.withdrawals(updated_at) where status in ('PREPARED', 'SUBMITTED', 'SENT', 'PROCESSING', 'VERIFYING');

alter table ops.withdrawals enable row level security;
create policy app_own on ops.withdrawals for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy worker_all on ops.withdrawals for all to obiba_worker using (true) with check (true);
create policy ops_read on ops.withdrawals for select to obiba_ops using (true);
grant select, insert on ops.withdrawals to obiba_app;
grant select, update on ops.withdrawals to obiba_worker;
grant select on ops.withdrawals to obiba_ops;

create table ops.invoice_deposits (
  id uuid primary key default gen_random_uuid(),
  invoice_id text not null references ops.invoices(invoice_id),
  origin_asset text not null,
  deposit_address text not null,
  deposit_memo text,
  amount_in text not null,
  refund_to text not null check (length(refund_to) between 2 and 100),
  quote jsonb not null,
  status text not null check (status in ('AWAITING_DEPOSIT', 'DETECTED', 'CONVERTING', 'DELIVERED', 'COMPLETED', 'INCOMPLETE', 'REFUND_PENDING', 'REFUNDED', 'EXPIRED', 'FAILED', 'REVIEW_REQUIRED')),
  tx_hashes jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (deposit_address, deposit_memo)
);
create unique index invoice_deposits_address_no_memo on ops.invoice_deposits(deposit_address) where deposit_memo is null;
create unique index invoice_deposits_one_active on ops.invoice_deposits(invoice_id)
  where status in ('AWAITING_DEPOSIT', 'DETECTED', 'CONVERTING', 'DELIVERED', 'INCOMPLETE', 'REFUND_PENDING');

alter table ops.invoice_deposits enable row level security;
create policy worker_all on ops.invoice_deposits for all to obiba_worker using (true) with check (true);
create policy ops_read on ops.invoice_deposits for select to obiba_ops using (true);
create policy indexer_all on ops.invoice_deposits for all to obiba_indexer using (true) with check (true);
grant select, update on ops.invoice_deposits to obiba_worker;
grant select on ops.invoice_deposits to obiba_ops;
grant select, update (status, updated_at) on ops.invoice_deposits to obiba_indexer;

create index sandbox_ops_by_ref on ops.sandbox_ops((receipt->>'ref'));

create function ops.reserve_invoice(p_invoice_id text)
returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if ops.current_uid() is null then
    return false;
  end if;
  update ops.invoices set status = 'PAYING'
   where invoice_id = p_invoice_id and status = 'OPEN'
     and expires_at_ns > (extract(epoch from clock_timestamp()) * 1000000000)::numeric
     and not exists (
       select 1 from ops.invoice_deposits d
        where d.invoice_id = p_invoice_id
          and d.status in ('AWAITING_DEPOSIT', 'DETECTED', 'CONVERTING', 'DELIVERED', 'INCOMPLETE', 'REFUND_PENDING'));
  return found;
end $$;

create function ops.release_invoice(p_invoice_id text)
returns void
language sql security definer set search_path = pg_catalog, pg_temp as $$
  update ops.invoices set status = 'OPEN'
   where invoice_id = p_invoice_id and status = 'PAYING'
     and not exists (
       select 1 from ops.prepared_ops p
        where p.invoice_id = p_invoice_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'SETTLED'))
     and not exists (
       select 1 from ops.invoice_deposits d
        where d.invoice_id = p_invoice_id
          and d.status in ('AWAITING_DEPOSIT', 'DETECTED', 'CONVERTING', 'DELIVERED', 'INCOMPLETE', 'REFUND_PENDING'));
$$;

create function ops.start_invoice_deposit(
  p_invoice_id text, p_origin text, p_address text, p_memo text, p_amount_in text, p_refund_to text, p_quote jsonb)
returns uuid
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_id uuid;
begin
  perform 1 from ops.invoices i
   where i.invoice_id = p_invoice_id and i.status = 'OPEN'
     and i.expires_at_ns > (extract(epoch from clock_timestamp()) * 1000000000)::numeric
   for update;
  if not found then
    return null;
  end if;
  if exists (select 1 from ops.prepared_ops p where p.invoice_id = p_invoice_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'SETTLED')) then
    return null;
  end if;
  insert into ops.invoice_deposits(invoice_id, origin_asset, deposit_address, deposit_memo, amount_in, refund_to, quote, status)
    values (p_invoice_id, p_origin, p_address, p_memo, p_amount_in, p_refund_to, p_quote, 'AWAITING_DEPOSIT')
    returning id into v_id;
  update ops.invoices set status = 'PAYING' where invoice_id = p_invoice_id;
  return v_id;
end $$;

create function ops.public_invoice_deposit(p_id uuid)
returns table(id uuid, invoice_id text, origin_asset text, deposit_address text, deposit_memo text, amount_in text,
              min_amount_in text, deadline text, time_estimate integer, status text, tx_hashes jsonb)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select d.id, d.invoice_id, d.origin_asset, d.deposit_address, d.deposit_memo, d.amount_in,
         coalesce(d.quote->'quote'->>'minAmountIn', d.amount_in), coalesce(d.quote->'quote'->>'deadline', ''),
         case when jsonb_typeof(d.quote->'quote'->'timeEstimate') = 'number' then (d.quote->'quote'->>'timeEstimate')::integer end,
         d.status, d.tx_hashes
    from ops.invoice_deposits d where d.id = p_id;
$$;

create function ops.resolve_recipient_by_phone(p_phone text)
returns table(display_name text, account_id text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select max(u.display_name), max(a.account_id)
    from identity.users u join chain.accounts a on a.uid = u.uid
   where u.phone_e164 = p_phone and u.status = 'active' and a.status = 'active'
     and ops.current_uid() is not null and p_phone ~ '^\+233[0-9]{9}$'
  having count(*) = 1;
$$;

create function ops.resolve_recipient_by_account(p_account text)
returns table(display_name text, account_id text, handle text, active boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select u.display_name, a.account_id, u.handle, (u.status = 'active' and a.status = 'active')
    from chain.accounts a join identity.users u on u.uid = a.uid
   where a.account_id = p_account and ops.current_uid() is not null;
$$;

create function ledger.my_activity_detail(p_limit integer, p_before bigint)
returns table(journal_id bigint, domain ledger.domain, kind text, op_ref text, amount text, currency text, created_at timestamptz,
              tx_hash text, receipt_id text, counterparty text, counterparty_name text, op_id text, sandbox_id text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  with me as (
    select 'wallet:' || a.account_id as wallet_ref, a.account_id from chain.accounts a where a.uid = ops.current_uid()
  ),
  mine as (
    select j.id, j.domain, j.kind, j.op_ref, e.amount, e.currency, j.created_at, j.source
      from ledger.entries e
      join ledger.journals j on j.id = e.journal_id
      join ledger.accounts la on la.id = e.account_id
     where ((la.domain = 'REAL' and la.kind = 'WALLET' and la.ref = (select wallet_ref from me))
         or (la.domain = 'DEMO' and la.kind = 'DEMO_USER' and la.ref = 'demo:' || ops.current_uid()))
       and (p_before is null or j.id < p_before)
     order by j.id desc
     limit least(greatest(coalesce(p_limit, 20), 1), 100)
  )
  select r.id, r.domain, r.kind, r.op_ref, r.amount::text, r.currency, r.created_at,
         ev.tx_hash, ev.receipt_id, cp.account, cu.display_name,
         substring(ev.raw->>'memo' from '^obiba:([0-9a-f]{32})'),
         case when r.domain = 'DEMO' then (
           select s.id::text from ops.sandbox_ops s
            where s.uid = ops.current_uid() and s.receipt->>'ref' = substring(r.op_ref from '^sandbox:([0-9a-f]{32})$'))
         end
    from mine r
    left join chain.events ev
      on r.domain = 'REAL' and ev.receipt_id = r.source->>'receipt_id' and ev.log_index = (r.source->>'log_index')::integer
    left join lateral (
      select case when r.amount > 0 then ev.from_account else ev.to_account end as account
    ) cp on true
    left join chain.accounts ca on ca.account_id = cp.account
    left join identity.users cu on cu.uid = ca.uid
   order by r.id desc;
$$;

grant execute on function ops.reserve_invoice(text),
  ops.start_invoice_deposit(text, text, text, text, text, text, jsonb), ops.public_invoice_deposit(uuid),
  ops.resolve_recipient_by_phone(text), ops.resolve_recipient_by_account(text),
  ledger.my_activity_detail(integer, bigint) to obiba_app;
grant execute on function ops.release_invoice(text) to obiba_indexer, obiba_worker;

create function ops.invoice_for_crosschain(p_invoice_id text)
returns table(invoice_id text, merchant_account text, token text, amount text, fee_bps integer, expires_at_ns text, reference text, signature text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select i.invoice_id, i.merchant_account, i.token, i.amount::text, i.fee_bps, i.expires_at_ns::text, i.reference, i.signature
    from ops.invoices i
   where i.invoice_id = p_invoice_id and p_invoice_id ~ '^[0-9a-f]{32}$' and i.status = 'OPEN';
$$;
grant execute on function ops.invoice_for_crosschain(text) to obiba_app;

create table ops.recoveries (
  id uuid primary key default gen_random_uuid(),
  uid text not null references identity.users(uid),
  account_id text not null references chain.accounts(account_id),
  new_public_key text not null check (new_public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  status text not null check (status in ('REQUESTED', 'SIGNED', 'SUBMITTED', 'PENDING_TIMELOCK', 'CANCEL_REQUESTED', 'COMPLETED', 'CANCELLED', 'FAILED')),
  guardian_nonce numeric(20, 0),
  guardian_sig text,
  cancel_delegate text,
  executable_at timestamptz,
  tx_hashes text[] not null default '{}',
  reason text check (length(reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index recoveries_one_active on ops.recoveries(uid)
  where status in ('REQUESTED', 'SIGNED', 'SUBMITTED', 'PENDING_TIMELOCK', 'CANCEL_REQUESTED');
create index recoveries_active on ops.recoveries(updated_at)
  where status in ('SIGNED', 'SUBMITTED', 'PENDING_TIMELOCK', 'CANCEL_REQUESTED');

alter table ops.recoveries enable row level security;
create policy app_own on ops.recoveries for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy worker_all on ops.recoveries for all to obiba_worker using (true) with check (true);
create policy guardian_read on ops.recoveries for select to obiba_guardian_ro using (true);
create policy ops_read on ops.recoveries for select to obiba_ops using (true);
grant select, insert on ops.recoveries to obiba_app;
grant update (status, guardian_nonce, guardian_sig, cancel_delegate, reason, updated_at) on ops.recoveries to obiba_app;
grant select, update on ops.recoveries to obiba_worker;
grant select on ops.recoveries to obiba_guardian_ro, obiba_ops;

grant select on chain.events, chain.cursor, ledger.entries, ledger.journals to obiba_worker;

create table ops.account_calls (
  call_id text primary key check (call_id ~ '^[0-9a-f]{32}$'),
  uid text not null references identity.users(uid),
  account_id text not null references chain.accounts(account_id),
  method text not null check (method in ('set_limit')),
  args_b64 text not null check (length(args_b64) <= 4000),
  status text not null check (status in ('PREPARED', 'SUBMITTED', 'SETTLED', 'FAILED')),
  signed_delegate text,
  tx_hash text,
  reason text check (length(reason) <= 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index account_calls_by_uid on ops.account_calls(uid, created_at desc);
alter table ops.account_calls enable row level security;
create policy app_own on ops.account_calls for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy worker_all on ops.account_calls for all to obiba_worker using (true) with check (true);
create policy ops_read on ops.account_calls for select to obiba_ops using (true);
grant select, insert on ops.account_calls to obiba_app;
grant update (status, signed_delegate, updated_at) on ops.account_calls to obiba_app;
grant select, update on ops.account_calls to obiba_worker;
grant select on ops.account_calls to obiba_ops;

alter table ops.invoices add column paid_event jsonb;
grant update (status, paid_event) on ops.invoices to obiba_indexer;

alter table ops.sandbox_ops drop constraint sandbox_ops_kind_check;
alter table ops.sandbox_ops add constraint sandbox_ops_kind_check
  check (kind in ('MOMO_FUND', 'BANK_FUND', 'AIRTIME', 'DATA', 'ECG', 'WATER', 'TV', 'MOMO_PAYOUT', 'BANK_PAYOUT'));
alter table ops.sandbox_ops add column quote jsonb;
alter table ops.sandbox_ops add column updated_at timestamptz not null default now();
create index sandbox_ops_pending on ops.sandbox_ops(created_at) where status = 'PENDING';
grant execute on function ledger.place_hold(text, bigint, numeric, timestamptz) to obiba_worker;

create table ops.notifications (
  id bigserial primary key,
  uid text not null references identity.users(uid),
  kind text not null check (kind ~ '^[A-Z_]{3,40}$'),
  ref text check (length(ref) <= 80),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  unique (uid, kind, ref)
);
create index notifications_by_uid on ops.notifications(uid, id desc);
alter table ops.notifications enable row level security;
create policy app_own on ops.notifications for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy worker_all on ops.notifications for all to obiba_worker using (true) with check (true);
create policy ops_read on ops.notifications for select to obiba_ops using (true);
grant select on ops.notifications to obiba_app;
grant update (read_at) on ops.notifications to obiba_app;
grant select, insert on ops.notifications to obiba_worker;
grant usage on sequence ops.notifications_id_seq to obiba_worker;

create policy ops_write on identity.users for update to obiba_ops using (true) with check (true);
create policy ops_write on chain.accounts for update to obiba_ops using (true) with check (true);
create policy ops_write on ops.deposits for update to obiba_ops using (true) with check (true);
create policy ops_write on ops.withdrawals for update to obiba_ops using (true) with check (true);
create policy ops_write on ops.invoice_deposits for update to obiba_ops using (true) with check (true);
create policy ops_write on ops.sandbox_ops for update to obiba_ops using (true) with check (true);
create policy ops_read on ops.sandbox_ops for select to obiba_ops using (true);
grant update (pilot_allowed, merchant, status, updated_at) on identity.users to obiba_ops;
grant update (status) on chain.accounts to obiba_ops;
grant update (status, updated_at) on ops.deposits, ops.withdrawals, ops.invoice_deposits to obiba_ops;
grant update (status, updated_at) on ops.sandbox_ops to obiba_ops;
grant insert on audit.log, infra.outbox to obiba_ops;
grant usage on sequence audit.log_id_seq, infra.outbox_id_seq to obiba_ops;
grant execute on function ledger.close_hold(text, text), ledger.post_demo_journal(text, text, jsonb, jsonb), ledger.ensure_account(ledger.domain, text, text, text) to obiba_ops;

create policy guardian_read on ops.account_calls for select to obiba_guardian_ro using (true);
grant select on ops.account_calls to obiba_guardian_ro;
grant execute on function ops.release_invoice(text) to obiba_ops;
grant update (credited_event) on ops.deposits to obiba_ops;
grant update (evidence) on ops.withdrawals to obiba_ops;
grant select, insert on ops.notifications to obiba_ops;
grant usage on sequence ops.notifications_id_seq to obiba_ops;
create policy ops_write on ops.notifications for insert to obiba_ops with check (true);
create policy ops_read on identity.devices for select to obiba_ops using (true);
grant update (receipt) on ops.sandbox_ops to obiba_ops;

alter table identity.users add column internal_tester boolean not null default false;
grant update (internal_tester) on identity.users to obiba_ops;

alter table ops.sandbox_ops add column funding text not null default 'DEMO' check (funding in ('DEMO', 'REAL_INTERNAL'));
alter table ops.sandbox_ops add column invoice_id text;
alter table ops.sandbox_ops add column op_id text;
create index sandbox_ops_by_invoice on ops.sandbox_ops(invoice_id) where invoice_id is not null;
create policy indexer_all on ops.sandbox_ops for all to obiba_indexer using (true) with check (true);
grant select, update (status, receipt, updated_at) on ops.sandbox_ops to obiba_indexer;

create function ops.create_internal_test_invoice(
  p_invoice_id text, p_biller_handle text, p_token text, p_amount numeric, p_fee_bps integer, p_expires_at_ns numeric, p_reference text, p_signature text)
returns table(merchant_account text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_uid text;
  v_account text;
begin
  if not exists (select 1 from identity.users u where u.uid = ops.current_uid() and u.internal_tester and u.status = 'active') then
    raise exception 'not an internal tester' using errcode = 'insufficient_privilege';
  end if;
  select u.uid, a.account_id into v_uid, v_account
    from identity.users u join chain.accounts a on a.uid = u.uid
   where u.handle = lower(p_biller_handle) and u.merchant and u.status = 'active' and a.status = 'active';
  if v_uid is null then
    raise exception 'internal test biller not available' using errcode = 'no_data_found';
  end if;
  if v_uid = ops.current_uid() then
    raise exception 'cannot pay yourself' using errcode = 'check_violation';
  end if;
  insert into ops.invoices(invoice_id, merchant_uid, merchant_account, token, amount, fee_bps, expires_at_ns, reference, signature, status)
    values (p_invoice_id, v_uid, v_account, p_token, p_amount, p_fee_bps, p_expires_at_ns, p_reference, p_signature, 'OPEN');
  return query select v_account;
end $$;

create function ops.internal_biller_account(p_biller_handle text)
returns text
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select a.account_id from identity.users u join chain.accounts a on a.uid = u.uid
   where u.handle = lower(p_biller_handle) and u.merchant and u.status = 'active' and a.status = 'active'
     and exists (select 1 from identity.users t where t.uid = ops.current_uid() and t.internal_tester);
$$;
grant execute on function ops.create_internal_test_invoice(text, text, text, numeric, integer, numeric, text, text), ops.internal_biller_account(text) to obiba_app;

create table identity.recovery_kits (
  id uuid primary key default gen_random_uuid(),
  uid text not null references identity.users(uid),
  public_key text not null unique check (public_key ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  registered_by_device text not null check (registered_by_device ~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  device_signature text not null check (device_signature ~ '^[A-Za-z0-9+/]{86}==$'),
  status text not null check (status in ('active', 'replaced')),
  created_at timestamptz not null default now(),
  replaced_at timestamptz
);
create unique index recovery_kits_one_active on identity.recovery_kits(uid) where status = 'active';
alter table identity.recovery_kits enable row level security;
create policy app_own on identity.recovery_kits for all to obiba_app using (uid = ops.current_uid()) with check (uid = ops.current_uid());
create policy guardian_read on identity.recovery_kits for select to obiba_guardian_ro using (true);
create policy ops_read on identity.recovery_kits for select to obiba_ops using (true);
grant select, insert on identity.recovery_kits to obiba_app;
grant update (status, replaced_at) on identity.recovery_kits to obiba_app;
grant select on identity.recovery_kits to obiba_guardian_ro, obiba_ops;

alter table ops.recoveries add column method text not null default 'TOTP' check (method in ('TOTP', 'KIT'));
alter table ops.recoveries add column kit_signature text check (kit_signature ~ '^[A-Za-z0-9+/]{86}==$');
grant update (kit_signature) on ops.recoveries to obiba_app;

grant insert on infra.outbox to obiba_worker;
grant insert on ops.notifications to obiba_app;
grant usage on sequence ops.notifications_id_seq to obiba_app;
