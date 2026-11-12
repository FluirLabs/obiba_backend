alter table ops.invoices
  add column payer_uid text references identity.users(uid),
  add column payer_account text references chain.accounts(account_id),
  add constraint invoice_payer_pair check ((payer_uid is null) = (payer_account is null)),
  add constraint invoice_payer_not_merchant check (payer_uid is null or payer_uid <> merchant_uid);

create function ops.invoice_payer(p_account text)
returns table(uid text, account_id text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select u.uid, a.account_id from identity.users u join chain.accounts a on a.uid = u.uid
   where a.account_id = p_account and u.status = 'active' and a.status = 'active'
     and ops.current_uid() is not null;
$$;

create function ops.keep_invoice_payer()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if new.payer_uid is distinct from old.payer_uid or new.payer_account is distinct from old.payer_account then
    raise exception 'invoice payer cannot be changed';
  end if;
  return new;
end;
$$;
create trigger invoice_payer_immutable before update on ops.invoices
for each row execute function ops.keep_invoice_payer();

drop function ops.public_invoice(text);
create function ops.public_invoice(p_invoice_id text)
returns table(invoice_id text, merchant_name text, merchant_account text, token text, amount text, fee_bps integer, expires_at_ns text, status text, requires_obiba boolean, can_pay boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select i.invoice_id, u.display_name, i.merchant_account, i.token, i.amount::text, i.fee_bps, i.expires_at_ns::text, i.status,
         i.payer_uid is not null, i.payer_uid is null or coalesce(i.payer_uid = ops.current_uid(), false)
    from ops.invoices i join identity.users u on u.uid = i.merchant_uid
   where i.invoice_id = p_invoice_id and p_invoice_id ~ '^[0-9a-f]{32}$';
$$;

drop function ops.invoice_for_payment(text);
create function ops.invoice_for_payment(p_invoice_id text)
returns table(invoice_id text, merchant_name text, merchant_account text, token text, amount text, fee_bps integer, expires_at_ns text, reference text, signature text, payer_account text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select i.invoice_id, u.display_name, i.merchant_account, i.token, i.amount::text, i.fee_bps, i.expires_at_ns::text, i.reference, i.signature, i.payer_account
    from ops.invoices i join identity.users u on u.uid = i.merchant_uid
   where i.invoice_id = p_invoice_id and p_invoice_id ~ '^[0-9a-f]{32}$' and i.status = 'OPEN'
     and ops.current_uid() is not null and (i.payer_uid is null or i.payer_uid = ops.current_uid());
$$;

create or replace function ops.invoice_for_crosschain(p_invoice_id text)
returns table(invoice_id text, merchant_account text, token text, amount text, fee_bps integer, expires_at_ns text, reference text, signature text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select i.invoice_id, i.merchant_account, i.token, i.amount::text, i.fee_bps, i.expires_at_ns::text, i.reference, i.signature
    from ops.invoices i
   where i.invoice_id = p_invoice_id and p_invoice_id ~ '^[0-9a-f]{32}$' and i.status = 'OPEN' and i.payer_uid is null;
$$;

create or replace function ops.reserve_invoice(p_invoice_id text)
returns boolean language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if ops.current_uid() is null then return false; end if;
  update ops.invoices set status = 'PAYING'
   where invoice_id = p_invoice_id and status = 'OPEN'
     and (payer_uid is null or payer_uid = ops.current_uid())
     and expires_at_ns > (extract(epoch from clock_timestamp()) * 1000000000)::numeric
     and not exists (select 1 from ops.invoice_deposits d where d.invoice_id = p_invoice_id
       and d.status in ('AWAITING_DEPOSIT', 'DETECTED', 'CONVERTING', 'DELIVERED', 'INCOMPLETE', 'REFUND_PENDING'));
  return found;
end;
$$;

create or replace function ops.start_invoice_deposit(
  p_invoice_id text, p_origin text, p_address text, p_memo text, p_amount_in text, p_refund_to text, p_quote jsonb)
returns uuid language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare v_id uuid;
begin
  perform 1 from ops.invoices i where i.invoice_id = p_invoice_id and i.status = 'OPEN' and i.payer_uid is null
    and i.expires_at_ns > (extract(epoch from clock_timestamp()) * 1000000000)::numeric for update;
  if not found then return null; end if;
  if exists (select 1 from ops.prepared_ops p where p.invoice_id = p_invoice_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'SETTLED')) then return null; end if;
  insert into ops.invoice_deposits(invoice_id, origin_asset, deposit_address, deposit_memo, amount_in, refund_to, quote, status)
    values (p_invoice_id, p_origin, p_address, p_memo, p_amount_in, p_refund_to, p_quote, 'AWAITING_DEPOSIT') returning id into v_id;
  update ops.invoices set status = 'PAYING' where invoice_id = p_invoice_id;
  return v_id;
end;
$$;

revoke all on function ops.invoice_payer(text), ops.keep_invoice_payer(), ops.public_invoice(text), ops.invoice_for_payment(text) from public;
grant execute on function ops.invoice_payer(text), ops.public_invoice(text), ops.invoice_for_payment(text) to obiba_app;
