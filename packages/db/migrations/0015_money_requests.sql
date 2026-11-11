create table ops.money_requests (
  request_id text primary key check (request_id ~ '^[0-9a-f]{32}$'),
  requester_uid text not null references identity.users(uid),
  requester_account text not null references chain.accounts(account_id),
  payer_uid text not null references identity.users(uid),
  amount numeric(39, 0) not null check (amount > 0),
  note text check (length(note) <= 80),
  status text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'DECLINED', 'CANCELLED')),
  paid_op_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (requester_uid <> payer_uid)
);
create index money_requests_by_requester on ops.money_requests(requester_uid, created_at desc);
create index money_requests_by_payer on ops.money_requests(payer_uid, created_at desc);
alter table ops.money_requests enable row level security;
create policy app_party on ops.money_requests for select to obiba_app using (requester_uid = ops.current_uid() or payer_uid = ops.current_uid());
create policy ops_read on ops.money_requests for select to obiba_ops using (true);
grant select on ops.money_requests to obiba_app, obiba_ops;

alter table ops.prepared_ops add column money_request_id text references ops.money_requests(request_id);
create index prepared_ops_by_money_request on ops.prepared_ops(money_request_id) where money_request_id is not null;

create function ops.request_payer(p_handle text)
returns table(uid text, display_name text, handle text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select u.uid, u.display_name, u.handle
    from identity.users u join chain.accounts a on a.uid = u.uid
   where u.handle = lower(p_handle) and u.status = 'active' and a.status = 'active'
     and ops.current_uid() is not null;
$$;

create function ops.create_money_request(p_request_id text, p_payer_uid text, p_amount numeric, p_note text)
returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_account text;
begin
  if v_me is null or p_payer_uid = v_me then raise exception 'invalid money request'; end if;
  select a.account_id into v_account from chain.accounts a where a.uid = v_me and a.status = 'active';
  if v_account is null then raise exception 'requester has no active account'; end if;
  if not exists (select 1 from identity.users u join chain.accounts a on a.uid = u.uid where u.uid = p_payer_uid and u.status = 'active' and a.status = 'active') then
    raise exception 'payer is not active';
  end if;
  insert into ops.money_requests(request_id, requester_uid, requester_account, payer_uid, amount, note)
  values (p_request_id, v_me, v_account, p_payer_uid, p_amount, p_note);
  insert into ops.notifications(uid, kind, ref) values (p_payer_uid, 'MONEY_REQUESTED', p_request_id) on conflict do nothing;
end;
$$;

create function ops.close_money_request(p_request_id text, p_action text)
returns table(status text, notify_uid text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_row ops.money_requests%rowtype;
begin
  select * into v_row from ops.money_requests r where r.request_id = p_request_id for update;
  if not found or v_row.status <> 'PENDING' then return; end if;
  if p_action = 'DECLINE' and v_row.payer_uid = v_me then
    if exists (select 1 from ops.prepared_ops p where p.money_request_id = p_request_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'SETTLED')) then return; end if;
    update ops.money_requests set status = 'DECLINED', updated_at = now() where request_id = p_request_id;
    insert into ops.notifications(uid, kind, ref) values (v_row.requester_uid, 'MONEY_REQUEST_DECLINED', p_request_id) on conflict do nothing;
    return query select 'DECLINED'::text, v_row.requester_uid;
  elsif p_action = 'CANCEL' and v_row.requester_uid = v_me then
    if exists (select 1 from ops.prepared_ops p where p.money_request_id = p_request_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'SETTLED')) then return; end if;
    update ops.money_requests set status = 'CANCELLED', updated_at = now() where request_id = p_request_id;
    return query select 'CANCELLED'::text, v_row.payer_uid;
  end if;
end;
$$;

create function ops.my_money_requests(p_limit integer)
returns table(request_id text, direction text, counterparty_name text, counterparty_handle text, counterparty_account text, amount text, note text, status text, paying boolean, created_at timestamptz, updated_at timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select r.request_id,
         case when r.requester_uid = ops.current_uid() then 'OUT' else 'IN' end,
         u.display_name, u.handle,
         case when r.requester_uid = ops.current_uid() then null else r.requester_account end,
         r.amount::text, r.note, r.status,
         r.status = 'PENDING' and exists (select 1 from ops.prepared_ops p where p.money_request_id = r.request_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN')),
         r.created_at, r.updated_at
    from ops.money_requests r
    join identity.users u on u.uid = case when r.requester_uid = ops.current_uid() then r.payer_uid else r.requester_uid end
   where ops.current_uid() is not null and (r.requester_uid = ops.current_uid() or r.payer_uid = ops.current_uid())
   order by r.created_at desc
   limit least(greatest(p_limit, 1), 100);
$$;

create function ops.settle_money_request(p_op_id text)
returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_requester text;
  v_request text;
begin
  update ops.money_requests r set status = 'PAID', paid_op_id = p_op_id, updated_at = now()
    from ops.prepared_ops p
   where p.op_id = p_op_id and p.status = 'SETTLED' and r.request_id = p.money_request_id and r.status in ('PENDING', 'DECLINED', 'CANCELLED')
  returning r.requester_uid, r.request_id into v_requester, v_request;
  if v_requester is not null then
    insert into ops.notifications(uid, kind, ref) values (v_requester, 'MONEY_REQUEST_PAID', v_request) on conflict do nothing;
  end if;
  return v_requester;
end;
$$;

grant execute on function ops.request_payer(text), ops.create_money_request(text, text, numeric, text), ops.close_money_request(text, text), ops.my_money_requests(integer) to obiba_app;
grant execute on function ops.settle_money_request(text) to obiba_indexer;
