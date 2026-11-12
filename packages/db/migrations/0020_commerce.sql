create table ops.businesses (
  business_id text primary key check (business_id ~ '^[0-9a-f]{24}$'),
  owner_uid text not null unique references identity.users(uid),
  owner_account text not null references chain.accounts(account_id),
  name text not null check (length(name) between 2 and 48),
  legal_name text not null check (length(legal_name) between 2 and 80),
  category text not null check (length(category) between 2 and 40),
  city text not null check (length(city) between 2 and 40),
  support_email text not null check (length(support_email) between 3 and 254),
  prefix text not null check (prefix ~ '^[A-Z0-9]{2}$'),
  verified boolean not null default true,
  created_at timestamptz not null default now()
);

create table ops.checkouts (
  checkout_id text primary key check (checkout_id ~ '^[0-9a-f]{24}$'),
  code text not null unique check (code ~ '^[A-HJ-NP-Z2-9]{6}$'),
  business_id text not null references ops.businesses(business_id),
  reference text not null check (reference ~ '^[A-Z0-9-]{1,24}$'),
  note text check (length(note) <= 80),
  items jsonb not null check (jsonb_typeof(items) = 'array'),
  amount numeric(14, 2) not null check (amount > 0 and amount <= 50000),
  rate numeric(18, 6) not null check (rate > 0),
  usdc numeric(39, 0) not null check (usdc > 0),
  quoted_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  status text not null default 'OPEN' check (status in ('OPEN', 'PAID', 'CANCELED', 'DECLINED')),
  requested_uid text references identity.users(uid),
  payment_id text,
  check (expires_at > created_at)
);
create unique index checkouts_open_reference on ops.checkouts(business_id, reference) where status = 'OPEN';
create index checkouts_by_business on ops.checkouts(business_id, created_at desc);
create index checkouts_by_requested on ops.checkouts(requested_uid, expires_at) where requested_uid is not null;

create table ops.checkout_payments (
  payment_id text primary key check (payment_id ~ '^[0-9a-f]{24}$'),
  receipt text not null unique check (receipt ~ '^OB-[0-9A-F]{4}-[0-9A-F]{4}$'),
  checkout_id text not null unique references ops.checkouts(checkout_id),
  business_id text not null references ops.businesses(business_id),
  amount numeric(14, 2) not null check (amount > 0),
  rate numeric(18, 6) not null check (rate > 0),
  usdc numeric(39, 0) not null check (usdc > 0),
  fee numeric(39, 0) not null check (fee >= 0),
  method text not null check (method in ('OBIBA', 'NEAR_WALLET')),
  wallet text check (length(wallet) <= 40),
  payer_uid text references identity.users(uid),
  payer_name text not null check (length(payer_name) between 1 and 80),
  payer_account text,
  tx_ref text not null check (length(tx_ref) between 16 and 64),
  created_at timestamptz not null default now(),
  settles_at timestamptz not null
);
create index checkout_payments_by_business on ops.checkout_payments(business_id, created_at desc);
create index checkout_payments_by_payer on ops.checkout_payments(payer_uid, created_at desc) where payer_uid is not null;
alter table ops.checkouts add constraint checkouts_payment_fk foreign key (payment_id) references ops.checkout_payments(payment_id) deferrable initially deferred;

create table ops.checkout_refunds (
  refund_id text primary key check (refund_id ~ '^[0-9a-f]{24}$'),
  payment_id text not null references ops.checkout_payments(payment_id),
  amount numeric(14, 2) not null check (amount > 0),
  usdc numeric(39, 0) not null check (usdc > 0),
  reason text not null check (length(reason) between 2 and 60),
  created_by text not null references identity.users(uid),
  created_at timestamptz not null default now(),
  completes_at timestamptz not null
);
create index checkout_refunds_by_payment on ops.checkout_refunds(payment_id, created_at);

create table ops.checkout_reports (
  report_id text primary key check (report_id ~ '^CS-[0-9A-F]{6}$'),
  payment_id text not null references ops.checkout_payments(payment_id),
  reporter_uid text not null references identity.users(uid),
  reason text not null check (length(reason) between 2 and 80),
  detail text not null default '' check (length(detail) <= 600),
  created_at timestamptz not null default now()
);
create index checkout_reports_by_payment on ops.checkout_reports(payment_id, created_at);

alter table ops.businesses enable row level security;
alter table ops.checkouts enable row level security;
alter table ops.checkout_payments enable row level security;
alter table ops.checkout_refunds enable row level security;
alter table ops.checkout_reports enable row level security;
create policy ops_read on ops.businesses for select to obiba_ops using (true);
create policy ops_read on ops.checkouts for select to obiba_ops using (true);
create policy ops_read on ops.checkout_payments for select to obiba_ops using (true);
create policy ops_read on ops.checkout_refunds for select to obiba_ops using (true);
create policy ops_read on ops.checkout_reports for select to obiba_ops using (true);
grant select on ops.businesses, ops.checkouts, ops.checkout_payments, ops.checkout_refunds, ops.checkout_reports to obiba_ops;

create function ops.commerce_business_json(b ops.businesses)
returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'businessId', b.business_id, 'name', b.name, 'legalName', b.legal_name, 'category', b.category, 'city', b.city,
    'supportEmail', b.support_email, 'prefix', b.prefix, 'verified', b.verified, 'ownerAccount', b.owner_account,
    'since', to_char(b.created_at at time zone 'UTC', 'YYYY-MM-DD'));
$$;

create function ops.commerce_checkout_json(c ops.checkouts)
returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'checkoutId', c.checkout_id, 'code', c.code, 'businessId', c.business_id, 'reference', c.reference, 'note', c.note,
    'items', c.items, 'amount', c.amount::text, 'rate', c.rate::text, 'usdc', c.usdc::text,
    'quotedAt', c.quoted_at, 'createdAt', c.created_at, 'expiresAt', c.expires_at, 'status', c.status,
    'requested', c.requested_uid is not null, 'paymentId', c.payment_id,
    'customer', case when c.requested_uid is null then null else
      (select jsonb_build_object('accountId', a.account_id, 'displayName', u.display_name, 'handle', u.handle)
         from identity.users u join chain.accounts a on a.uid = u.uid where u.uid = c.requested_uid) end);
$$;

create function ops.commerce_payment_json(p ops.checkout_payments, p_me text)
returns jsonb
language sql stable set search_path = pg_catalog, pg_temp as $$
  select jsonb_build_object(
    'paymentId', p.payment_id, 'receipt', p.receipt, 'checkoutId', p.checkout_id, 'businessId', p.business_id,
    'reference', c.reference, 'items', c.items, 'amount', p.amount::text, 'rate', p.rate::text, 'usdc', p.usdc::text,
    'fee', p.fee::text, 'method', p.method, 'wallet', p.wallet, 'payerName', p.payer_name, 'payerAccount', p.payer_account,
    'mine', p.payer_uid is not null and p.payer_uid = p_me, 'txRef', p.tx_ref, 'createdAt', p.created_at, 'settlesAt', p.settles_at,
    'refunds', coalesce((select jsonb_agg(jsonb_build_object('refundId', r.refund_id, 'amount', r.amount::text, 'usdc', r.usdc::text, 'reason', r.reason, 'createdAt', r.created_at, 'completesAt', r.completes_at) order by r.created_at)
                           from ops.checkout_refunds r where r.payment_id = p.payment_id), '[]'::jsonb),
    'reports', coalesce((select jsonb_agg(jsonb_build_object('reportId', x.report_id, 'reason', x.reason, 'detail', x.detail, 'createdAt', x.created_at) order by x.created_at)
                           from ops.checkout_reports x where x.payment_id = p.payment_id and x.reporter_uid = p_me), '[]'::jsonb))
    from ops.checkouts c where c.checkout_id = p.checkout_id;
$$;

create function ops.my_commerce()
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_business ops.businesses;
begin
  if v_me is null then raise exception 'COMMERCE_UNAUTHENTICATED'; end if;
  select * into v_business from ops.businesses b where b.owner_uid = v_me;
  return jsonb_build_object(
    'business', case when v_business.business_id is null then null else ops.commerce_business_json(v_business) end,
    'links', coalesce((select jsonb_agg(ops.commerce_checkout_json(c) order by c.created_at desc) from ops.checkouts c where c.business_id = v_business.business_id), '[]'::jsonb),
    'requests', coalesce((select jsonb_agg(ops.commerce_checkout_json(c) order by c.expires_at) from ops.checkouts c where c.requested_uid = v_me and c.status = 'OPEN' and c.expires_at > now()), '[]'::jsonb),
    'businessPayments', coalesce((select jsonb_agg(ops.commerce_payment_json(p, v_me) order by p.created_at desc) from ops.checkout_payments p where p.business_id = v_business.business_id), '[]'::jsonb),
    'purchases', coalesce((select jsonb_agg(ops.commerce_payment_json(p, v_me) order by p.created_at desc) from ops.checkout_payments p where p.payer_uid = v_me), '[]'::jsonb),
    'merchants', coalesce((select jsonb_agg(ops.commerce_business_json(b)) from ops.businesses b
                            where b.business_id in (select p.business_id from ops.checkout_payments p where p.payer_uid = v_me
                                                    union select c.business_id from ops.checkouts c where c.requested_uid = v_me and c.status = 'OPEN')), '[]'::jsonb));
end;
$$;

create function ops.public_checkout(p_key text)
returns jsonb
language plpgsql stable security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_c ops.checkouts;
  v_b ops.businesses;
  v_p ops.checkout_payments;
begin
  if p_key ~ '^[0-9a-f]{24}$' then
    select * into v_c from ops.checkouts c where c.checkout_id = p_key;
  elsif upper(p_key) ~ '^[A-HJ-NP-Z2-9]{6}$' then
    select * into v_c from ops.checkouts c where c.code = upper(p_key);
  end if;
  if v_c.checkout_id is null then return null; end if;
  select * into v_b from ops.businesses b where b.business_id = v_c.business_id;
  if v_c.payment_id is not null then select * into v_p from ops.checkout_payments p where p.payment_id = v_c.payment_id; end if;
  return jsonb_build_object(
    'checkout', ops.commerce_checkout_json(v_c),
    'business', ops.commerce_business_json(v_b),
    'own', v_me is not null and v_b.owner_uid = v_me,
    'forMe', v_c.requested_uid is null or v_c.requested_uid = v_me,
    'payment', case when v_p.payment_id is not null and v_me is not null and (v_p.payer_uid = v_me or v_b.owner_uid = v_me) then ops.commerce_payment_json(v_p, v_me) else null end);
end;
$$;

create function ops.create_business(p_business_id text, p_name text, p_legal_name text, p_category text, p_city text, p_support_email text, p_prefix text)
returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_account text;
begin
  if v_me is null then raise exception 'COMMERCE_UNAUTHENTICATED'; end if;
  select a.account_id into v_account from chain.accounts a where a.uid = v_me and a.status = 'active';
  if v_account is null then raise exception 'COMMERCE_NO_ACCOUNT'; end if;
  if exists (select 1 from ops.businesses b where b.owner_uid = v_me) then raise exception 'BUSINESS_EXISTS'; end if;
  insert into ops.businesses(business_id, owner_uid, owner_account, name, legal_name, category, city, support_email, prefix)
  values (p_business_id, v_me, v_account, p_name, p_legal_name, p_category, p_city, p_support_email, p_prefix);
end;
$$;

create function ops.create_checkout(p_checkout_id text, p_code text, p_reference text, p_note text, p_items jsonb, p_amount numeric, p_rate numeric, p_usdc numeric, p_expires_at timestamptz, p_customer_uid text)
returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_business text;
begin
  if v_me is null then raise exception 'COMMERCE_UNAUTHENTICATED'; end if;
  select b.business_id into v_business from ops.businesses b where b.owner_uid = v_me;
  if v_business is null then raise exception 'BUSINESS_MISSING'; end if;
  if p_customer_uid is not null and (p_customer_uid = v_me or not exists (
       select 1 from identity.users u join chain.accounts a on a.uid = u.uid where u.uid = p_customer_uid and u.status = 'active' and a.status = 'active')) then
    raise exception 'CHECKOUT_CUSTOMER_INVALID';
  end if;
  if exists (select 1 from ops.checkouts c where c.business_id = v_business and c.reference = p_reference and c.status = 'OPEN' and c.expires_at > now()) then
    raise exception 'CHECKOUT_REFERENCE_TAKEN';
  end if;
  update ops.checkouts set status = 'CANCELED' where business_id = v_business and reference = p_reference and status = 'OPEN' and expires_at <= now();
  insert into ops.checkouts(checkout_id, code, business_id, reference, note, items, amount, rate, usdc, expires_at, requested_uid)
  values (p_checkout_id, p_code, v_business, p_reference, p_note, p_items, p_amount, p_rate, p_usdc, p_expires_at, p_customer_uid);
end;
$$;

create function ops.close_checkout(p_checkout_id text, p_action text)
returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_c ops.checkouts;
  v_owner text;
begin
  if v_me is null then raise exception 'COMMERCE_UNAUTHENTICATED'; end if;
  select * into v_c from ops.checkouts c where c.checkout_id = p_checkout_id for update;
  if v_c.checkout_id is null then raise exception 'CHECKOUT_NOT_FOUND'; end if;
  select b.owner_uid into v_owner from ops.businesses b where b.business_id = v_c.business_id;
  if p_action = 'CANCEL' and v_owner <> v_me then raise exception 'CHECKOUT_NOT_FOUND'; end if;
  if p_action = 'DECLINE' and v_c.requested_uid is distinct from v_me then raise exception 'CHECKOUT_NOT_FOUND'; end if;
  if v_c.status <> 'OPEN' or v_c.expires_at <= now() then return null; end if;
  update ops.checkouts set status = case when p_action = 'CANCEL' then 'CANCELED' else 'DECLINED' end where checkout_id = p_checkout_id;
  return case when p_action = 'CANCEL' then 'CANCELED' else 'DECLINED' end;
end;
$$;

create function ops.requote_checkout(p_checkout_id text, p_rate numeric, p_usdc numeric)
returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  update ops.checkouts set rate = p_rate, usdc = p_usdc, quoted_at = now()
   where checkout_id = p_checkout_id and status = 'OPEN' and expires_at > now();
  return found;
end;
$$;

create function ops.pay_checkout(p_checkout_id text, p_payment_id text, p_receipt text, p_method text, p_wallet text, p_payer_name text, p_payer_account text, p_tx_ref text, p_fee_bps integer, p_quote_seconds integer, p_settle_seconds integer)
returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_c ops.checkouts;
  v_owner text;
begin
  select * into v_c from ops.checkouts c where c.checkout_id = p_checkout_id for update;
  if v_c.checkout_id is null then return 'NOT_FOUND'; end if;
  if v_c.status <> 'OPEN' then return v_c.status; end if;
  if v_c.expires_at <= now() then return 'EXPIRED'; end if;
  select b.owner_uid into v_owner from ops.businesses b where b.business_id = v_c.business_id;
  if p_method = 'OBIBA' and (v_me is null or p_payer_account is null) then raise exception 'COMMERCE_UNAUTHENTICATED'; end if;
  if v_me is not null and v_owner = v_me then return 'OWN'; end if;
  if v_c.requested_uid is not null and v_c.requested_uid is distinct from v_me then return 'NOT_FOR_YOU'; end if;
  if v_c.quoted_at < now() - make_interval(secs => p_quote_seconds) then return 'QUOTE_EXPIRED'; end if;
  insert into ops.checkout_payments(payment_id, receipt, checkout_id, business_id, amount, rate, usdc, fee, method, wallet, payer_uid, payer_name, payer_account, tx_ref, settles_at)
  values (p_payment_id, p_receipt, v_c.checkout_id, v_c.business_id, v_c.amount, v_c.rate, v_c.usdc, (v_c.usdc * p_fee_bps) / 10000, p_method, p_wallet,
          case when p_method = 'OBIBA' then v_me else null end, p_payer_name, p_payer_account, p_tx_ref, now() + make_interval(secs => p_settle_seconds));
  update ops.checkouts set status = 'PAID', payment_id = p_payment_id where checkout_id = v_c.checkout_id;
  return 'OK';
end;
$$;

create function ops.refund_checkout_payment(p_refund_id text, p_payment_id text, p_amount numeric, p_reason text, p_complete_seconds integer)
returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_p ops.checkout_payments;
  v_owner text;
  v_refunded numeric;
begin
  if v_me is null then raise exception 'COMMERCE_UNAUTHENTICATED'; end if;
  select * into v_p from ops.checkout_payments p where p.payment_id = p_payment_id for update;
  if v_p.payment_id is null then return 'NOT_FOUND'; end if;
  select b.owner_uid into v_owner from ops.businesses b where b.business_id = v_p.business_id;
  if v_owner <> v_me then return 'NOT_FOUND'; end if;
  if v_p.settles_at > now() then return 'PROCESSING'; end if;
  if p_amount <= 0 then return 'INVALID'; end if;
  select coalesce(sum(r.amount), 0) into v_refunded from ops.checkout_refunds r where r.payment_id = p_payment_id;
  if v_refunded + p_amount > v_p.amount then return 'TOO_MUCH'; end if;
  insert into ops.checkout_refunds(refund_id, payment_id, amount, usdc, reason, created_by, completes_at)
  values (p_refund_id, p_payment_id, p_amount, ceil((p_amount / v_p.amount) * v_p.usdc), p_reason, v_me, now() + make_interval(secs => p_complete_seconds));
  return 'OK';
end;
$$;

create function ops.report_checkout_payment(p_report_id text, p_payment_id text, p_reason text, p_detail text)
returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
begin
  if v_me is null then raise exception 'COMMERCE_UNAUTHENTICATED'; end if;
  if not exists (select 1 from ops.checkout_payments p where p.payment_id = p_payment_id and p.payer_uid = v_me) then return false; end if;
  insert into ops.checkout_reports(report_id, payment_id, reporter_uid, reason, detail) values (p_report_id, p_payment_id, v_me, p_reason, p_detail);
  return true;
end;
$$;

create function ops.commerce_business_owner(p_business_id text)
returns text
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select b.owner_uid from ops.businesses b where b.business_id = p_business_id;
$$;

create function ops.commerce_payment(p_payment_id text)
returns jsonb
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select ops.commerce_payment_json(p, ops.current_uid())
    from ops.checkout_payments p join ops.businesses b on b.business_id = p.business_id
   where p.payment_id = p_payment_id
     and ((ops.current_uid() is not null and (p.payer_uid = ops.current_uid() or b.owner_uid = ops.current_uid()))
          or (p.payer_uid is null and p.created_at > now() - interval '10 minutes'));
$$;

revoke all on function ops.commerce_business_json(ops.businesses), ops.commerce_checkout_json(ops.checkouts), ops.commerce_payment_json(ops.checkout_payments, text) from public;
revoke all on function ops.my_commerce(), ops.public_checkout(text), ops.create_business(text, text, text, text, text, text, text),
  ops.create_checkout(text, text, text, text, jsonb, numeric, numeric, numeric, timestamptz, text), ops.close_checkout(text, text), ops.requote_checkout(text, numeric, numeric),
  ops.pay_checkout(text, text, text, text, text, text, text, text, integer, integer, integer), ops.refund_checkout_payment(text, text, numeric, text, integer),
  ops.report_checkout_payment(text, text, text, text), ops.commerce_business_owner(text), ops.commerce_payment(text) from public;
grant execute on function ops.my_commerce(), ops.public_checkout(text), ops.create_business(text, text, text, text, text, text, text),
  ops.create_checkout(text, text, text, text, jsonb, numeric, numeric, numeric, timestamptz, text), ops.close_checkout(text, text), ops.requote_checkout(text, numeric, numeric),
  ops.pay_checkout(text, text, text, text, text, text, text, text, integer, integer, integer), ops.refund_checkout_payment(text, text, numeric, text, integer),
  ops.report_checkout_payment(text, text, text, text), ops.commerce_business_owner(text), ops.commerce_payment(text) to obiba_app;
