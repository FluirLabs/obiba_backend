create table ops.request_policy (
  id boolean primary key default true check (id),
  max_first_asks_per_day integer not null default 5 check (max_first_asks_per_day > 0),
  max_requests_per_day integer not null default 20 check (max_requests_per_day > 0),
  max_inbox_asks_per_day integer not null default 10 check (max_inbox_asks_per_day > 0),
  ask_ttl interval not null default '14 days',
  payable_ttl interval not null default '7 days',
  cooldown interval not null default '30 days',
  abuse_window interval not null default '30 days',
  abuse_min_asks integer not null default 5,
  abuse_ratio numeric(3, 2) not null default 0.60 check (abuse_ratio > 0 and abuse_ratio <= 1),
  abuse_blocks integer not null default 3,
  restriction interval not null default '7 days',
  repeat_restriction interval not null default '30 days'
);
insert into ops.request_policy default values;
alter table ops.request_policy enable row level security;
create policy ops_read on ops.request_policy for select to obiba_ops using (true);
grant select on ops.request_policy to obiba_ops;

alter table ops.money_requests drop constraint money_requests_status_check;
alter table ops.money_requests add constraint money_requests_status_check check (status in ('PENDING', 'PAID', 'DECLINED', 'CANCELLED', 'EXPIRED'));
alter table ops.money_requests add column permission text not null default 'NOT_NEEDED'
  check (permission in ('NOT_NEEDED', 'ASKING', 'ALLOWED', 'ALLOWED_ONCE', 'BLOCKED', 'EXPIRED'));
alter table ops.money_requests add column opened_at timestamptz;
alter table ops.money_requests add column paid_receipt_id text;
alter table ops.money_requests add column paid_log_index integer;
create unique index money_requests_paid_event on ops.money_requests(paid_receipt_id, paid_log_index) where paid_receipt_id is not null;
update ops.money_requests set permission = 'ASKING' where status = 'PENDING';
update ops.money_requests set opened_at = created_at where permission = 'NOT_NEEDED';
create unique index money_requests_one_ask_per_pair on ops.money_requests(requester_uid, payer_uid) where status = 'PENDING' and permission = 'ASKING';
create index money_requests_pair on ops.money_requests(requester_uid, payer_uid, created_at desc);
create index money_requests_open on ops.money_requests(created_at) where status = 'PENDING';

create table ops.request_permissions (
  id bigserial primary key,
  user_a text not null references identity.users(uid),
  user_b text not null references identity.users(uid),
  status text not null check (status in ('ALLOWED', 'REVOKED')),
  granted_by text not null references identity.users(uid),
  granted_at timestamptz not null default now(),
  revoked_by text references identity.users(uid),
  revoked_at timestamptz,
  check (user_a < user_b),
  check (granted_by in (user_a, user_b)),
  unique (user_a, user_b)
);
alter table ops.request_permissions enable row level security;
create policy app_party on ops.request_permissions for select to obiba_app using (ops.current_uid() in (user_a, user_b));
create policy ops_read on ops.request_permissions for select to obiba_ops using (true);
grant select on ops.request_permissions to obiba_app, obiba_ops;

create table ops.request_blocks (
  id bigserial primary key,
  blocker_uid text not null references identity.users(uid),
  blocked_uid text not null references identity.users(uid),
  created_at timestamptz not null default now(),
  unique (blocker_uid, blocked_uid),
  check (blocker_uid <> blocked_uid)
);
alter table ops.request_blocks enable row level security;
create policy app_own on ops.request_blocks for select to obiba_app using (blocker_uid = ops.current_uid());
create policy ops_read on ops.request_blocks for select to obiba_ops using (true);
grant select on ops.request_blocks to obiba_app, obiba_ops;

create table ops.request_restrictions (
  id bigserial primary key,
  uid text not null references identity.users(uid),
  reason text not null check (length(reason) <= 200),
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  check (ends_at > starts_at)
);
create index request_restrictions_by_uid on ops.request_restrictions(uid, ends_at desc);
alter table ops.request_restrictions enable row level security;
create policy ops_read on ops.request_restrictions for select to obiba_ops using (true);
grant select on ops.request_restrictions to obiba_ops;

create function ops.request_audit(p_actor text, p_action text, p_target text, p_details jsonb)
returns void
language sql security definer set search_path = pg_catalog, pg_temp as $$
  insert into audit.log(actor, action, target, outcome, details) values (coalesce(p_actor, 'system'), p_action, p_target, 'ALLOWED', coalesce(p_details, '{}'::jsonb));
$$;

create function ops.request_pair_allowed(p_a text, p_b text)
returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (
    select 1 from ops.request_permissions p
     where p.user_a = least(p_a, p_b) and p.user_b = greatest(p_a, p_b) and p.status = 'ALLOWED'
  ) and not exists (
    select 1 from ops.request_blocks b
     where (b.blocker_uid = p_a and b.blocked_uid = p_b) or (b.blocker_uid = p_b and b.blocked_uid = p_a)
  );
$$;

create function ops.evaluate_requester(p_uid text)
returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  pol ops.request_policy%rowtype;
  v_asks integer;
  v_bad integer;
  v_blocks integer;
  v_prior integer;
  v_length interval;
  v_reason text;
begin
  select * into pol from ops.request_policy limit 1;
  if exists (select 1 from ops.request_restrictions r where r.uid = p_uid and r.ends_at > now()) then
    return;
  end if;
  select count(*) filter (where m.permission <> 'NOT_NEEDED'),
         count(*) filter (where m.permission in ('BLOCKED', 'EXPIRED') or (m.permission <> 'NOT_NEEDED' and m.status = 'DECLINED')),
         count(*) filter (where m.permission = 'BLOCKED')
    into v_asks, v_bad, v_blocks
    from ops.money_requests m
   where m.requester_uid = p_uid and m.created_at > now() - pol.abuse_window;
  if v_blocks >= pol.abuse_blocks then
    v_reason := format('blocked by %s people in %s', v_blocks, pol.abuse_window);
  elsif v_asks >= pol.abuse_min_asks and v_bad::numeric / v_asks >= pol.abuse_ratio then
    v_reason := format('%s of %s first requests ignored, declined or blocked in %s', v_bad, v_asks, pol.abuse_window);
  else
    return;
  end if;
  select count(*) into v_prior from ops.request_restrictions r where r.uid = p_uid;
  v_length := case when v_prior > 0 then pol.repeat_restriction else pol.restriction end;
  insert into ops.request_restrictions(uid, reason, ends_at) values (p_uid, v_reason, now() + v_length);
  perform ops.request_audit('system', 'request.restrict', p_uid, jsonb_build_object('reason', v_reason, 'length', v_length::text));
end;
$$;

create function ops.expire_money_requests()
returns void
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  pol ops.request_policy%rowtype;
  v_uid text;
begin
  select * into pol from ops.request_policy limit 1;
  for v_uid in
    with expired as (
      update ops.money_requests m set status = 'EXPIRED', permission = 'EXPIRED', updated_at = now()
       where m.status = 'PENDING' and m.permission = 'ASKING' and m.created_at <= now() - pol.ask_ttl
      returning m.requester_uid
    )
    select distinct requester_uid from expired
  loop
    perform ops.evaluate_requester(v_uid);
  end loop;
  update ops.money_requests m set status = 'EXPIRED', updated_at = now()
   where m.status = 'PENDING' and m.permission in ('NOT_NEEDED', 'ALLOWED', 'ALLOWED_ONCE')
     and coalesce(m.opened_at, m.created_at) <= now() - pol.payable_ttl
     and not exists (select 1 from ops.prepared_ops p where p.money_request_id = m.request_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'SETTLED'));
end;
$$;

drop function ops.create_money_request(text, text, numeric, text);
create function ops.create_money_request(p_request_id text, p_payer_uid text, p_amount numeric, p_note text)
returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  pol ops.request_policy%rowtype;
  v_account text;
  v_permission text;
begin
  if v_me is null or p_payer_uid = v_me then raise exception 'invalid money request'; end if;
  select * into pol from ops.request_policy limit 1;
  perform ops.expire_money_requests();
  perform pg_advisory_xact_lock(hashtext('money_request:' || v_me));

  select a.account_id into v_account from chain.accounts a join identity.users u on u.uid = a.uid
   where a.uid = v_me and a.status = 'active' and u.status = 'active';
  if v_account is null then raise exception 'requester has no active account'; end if;
  if not exists (select 1 from identity.users u join chain.accounts a on a.uid = u.uid where u.uid = p_payer_uid and u.status = 'active' and a.status = 'active') then
    raise exception 'payer is not active';
  end if;

  if exists (select 1 from ops.request_blocks b where b.blocker_uid = p_payer_uid and b.blocked_uid = v_me) then
    raise exception 'REQUEST_BLOCKED';
  end if;

  if (select count(*) from ops.money_requests m where m.requester_uid = v_me and m.created_at > now() - interval '24 hours') >= pol.max_requests_per_day then
    raise exception 'REQUEST_LIMIT';
  end if;

  if ops.request_pair_allowed(v_me, p_payer_uid) then
    v_permission := 'NOT_NEEDED';
  else
    if exists (select 1 from ops.request_restrictions r where r.uid = v_me and r.ends_at > now()) then
      raise exception 'REQUEST_RESTRICTED';
    end if;
    if exists (select 1 from ops.money_requests m where m.requester_uid = v_me and m.payer_uid = p_payer_uid and m.status = 'PENDING' and m.permission = 'ASKING') then
      raise exception 'REQUEST_PENDING';
    end if;
    if exists (select 1 from ops.money_requests m
                where m.requester_uid = v_me and m.payer_uid = p_payer_uid
                  and m.permission in ('EXPIRED', 'BLOCKED') and m.updated_at > now() - pol.cooldown) then
      raise exception 'REQUEST_COOLDOWN';
    end if;
    if (select count(*) from ops.money_requests m
         where m.requester_uid = v_me and m.permission <> 'NOT_NEEDED' and m.created_at > now() - interval '24 hours') >= pol.max_first_asks_per_day then
      raise exception 'REQUEST_ASK_LIMIT';
    end if;
    perform pg_advisory_xact_lock(hashtext('money_request_inbox:' || p_payer_uid));
    if (select count(*) from ops.money_requests m
         where m.payer_uid = p_payer_uid and m.permission <> 'NOT_NEEDED' and m.created_at > now() - interval '24 hours') >= pol.max_inbox_asks_per_day then
      raise exception 'REQUEST_INBOX_FULL';
    end if;
    v_permission := 'ASKING';
  end if;

  insert into ops.money_requests(request_id, requester_uid, requester_account, payer_uid, amount, note, permission, opened_at)
  values (p_request_id, v_me, v_account, p_payer_uid, p_amount, p_note, v_permission, case when v_permission = 'NOT_NEEDED' then now() end);
  insert into ops.notifications(uid, kind, ref) values (p_payer_uid, 'MONEY_REQUESTED', p_request_id) on conflict do nothing;
  return v_permission;
end;
$$;

create function ops.respond_money_request(p_request_id text, p_decision text)
returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_row ops.money_requests%rowtype;
begin
  if v_me is null or p_decision not in ('ALLOW', 'ALLOW_ONCE', 'BLOCK') then raise exception 'invalid decision'; end if;
  perform ops.expire_money_requests();
  select * into v_row from ops.money_requests m where m.request_id = p_request_id for update;
  if not found or v_row.payer_uid <> v_me then raise exception 'REQUEST_NOT_FOUND'; end if;
  if v_row.status <> 'PENDING' then raise exception 'REQUEST_CLOSED'; end if;

  if p_decision = 'BLOCK' then
    if exists (select 1 from ops.prepared_ops p where p.money_request_id = p_request_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'SETTLED')) then
      raise exception 'REQUEST_PAYING';
    end if;
    insert into ops.request_blocks(blocker_uid, blocked_uid) values (v_me, v_row.requester_uid) on conflict do nothing;
    update ops.request_permissions p set status = 'REVOKED', revoked_by = v_me, revoked_at = now()
     where p.user_a = least(v_me, v_row.requester_uid) and p.user_b = greatest(v_me, v_row.requester_uid) and p.status = 'ALLOWED';
    update ops.money_requests m set status = 'DECLINED', permission = 'BLOCKED', updated_at = now()
     where m.requester_uid = v_row.requester_uid and m.payer_uid = v_me and m.status = 'PENDING'
       and not exists (select 1 from ops.prepared_ops p where p.money_request_id = m.request_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'SETTLED'));
    perform ops.request_audit(v_me, 'request.block', v_row.requester_uid, jsonb_build_object('request_id', p_request_id));
    perform ops.evaluate_requester(v_row.requester_uid);
    return 'BLOCKED';
  end if;

  if v_row.permission <> 'ASKING' then raise exception 'REQUEST_NOT_ASKING'; end if;

  if p_decision = 'ALLOW' then
    insert into ops.request_permissions(user_a, user_b, status, granted_by)
    values (least(v_me, v_row.requester_uid), greatest(v_me, v_row.requester_uid), 'ALLOWED', v_me)
    on conflict (user_a, user_b) do update set status = 'ALLOWED', granted_by = excluded.granted_by, granted_at = now(), revoked_by = null, revoked_at = null;
    update ops.money_requests set permission = 'ALLOWED', opened_at = now(), updated_at = now() where request_id = p_request_id;
    perform ops.request_audit(v_me, 'request_permission.grant', v_row.requester_uid, jsonb_build_object('request_id', p_request_id));
    return 'ALLOWED';
  end if;

  update ops.money_requests set permission = 'ALLOWED_ONCE', opened_at = now(), updated_at = now() where request_id = p_request_id;
  perform ops.request_audit(v_me, 'request_permission.allow_once', v_row.requester_uid, jsonb_build_object('request_id', p_request_id));
  return 'ALLOWED_ONCE';
end;
$$;

create or replace function ops.close_money_request(p_request_id text, p_action text)
returns table(status text, notify_uid text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_row ops.money_requests%rowtype;
begin
  perform ops.expire_money_requests();
  select * into v_row from ops.money_requests r where r.request_id = p_request_id for update;
  if not found or v_row.status <> 'PENDING' then return; end if;
  if exists (select 1 from ops.prepared_ops p where p.money_request_id = p_request_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'SETTLED')) then return; end if;
  if p_action = 'DECLINE' and v_row.payer_uid = v_me and v_row.permission in ('NOT_NEEDED', 'ALLOWED', 'ALLOWED_ONCE') then
    update ops.money_requests set status = 'DECLINED', updated_at = now() where request_id = p_request_id;
    insert into ops.notifications(uid, kind, ref) values (v_row.requester_uid, 'MONEY_REQUEST_DECLINED', p_request_id) on conflict do nothing;
    if v_row.permission <> 'NOT_NEEDED' then perform ops.evaluate_requester(v_row.requester_uid); end if;
    return query select 'DECLINED'::text, v_row.requester_uid;
  elsif p_action = 'CANCEL' and v_row.requester_uid = v_me then
    update ops.money_requests set status = 'CANCELLED', updated_at = now() where request_id = p_request_id;
    return query select 'CANCELLED'::text, v_row.payer_uid;
  end if;
end;
$$;

create function ops.payable_money_request(p_request_id text)
returns table(requester_account text, amount text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select m.requester_account, m.amount::text
    from ops.money_requests m, ops.request_policy pol
   where m.request_id = p_request_id
     and m.payer_uid = ops.current_uid()
     and m.status = 'PENDING'
     and m.permission in ('NOT_NEEDED', 'ALLOWED', 'ALLOWED_ONCE')
     and coalesce(m.opened_at, m.created_at) > now() - pol.payable_ttl
     and not exists (select 1 from ops.request_blocks b where b.blocker_uid = m.payer_uid and b.blocked_uid = m.requester_uid);
$$;

drop function ops.my_money_requests(integer);
create function ops.my_money_requests(p_limit integer)
returns table(request_id text, direction text, counterparty_name text, counterparty_handle text, counterparty_account text, amount text, note text, status text, permission text, paying boolean, created_at timestamptz, updated_at timestamptz)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if ops.current_uid() is null then return; end if;
  perform ops.expire_money_requests();
  return query
  select r.request_id,
         case when r.requester_uid = ops.current_uid() then 'OUT' else 'IN' end,
         u.display_name, u.handle,
         case when r.requester_uid = ops.current_uid() then null else r.requester_account end,
         r.amount::text, r.note, r.status,
         case when r.requester_uid = ops.current_uid() and r.permission = 'BLOCKED' then 'NOT_ACCEPTED' else r.permission end,
         r.status = 'PENDING' and exists (select 1 from ops.prepared_ops p where p.money_request_id = r.request_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN')),
         r.created_at, r.updated_at
    from ops.money_requests r
    join identity.users u on u.uid = case when r.requester_uid = ops.current_uid() then r.payer_uid else r.requester_uid end
   where r.requester_uid = ops.current_uid() or r.payer_uid = ops.current_uid()
   order by r.created_at desc
   limit least(greatest(p_limit, 1), 100);
end;
$$;

create function ops.my_request_contacts()
returns table(id text, kind text, name text, handle text, since timestamptz)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select 'p' || p.id, 'ALLOWED', u.display_name, u.handle, p.granted_at
    from ops.request_permissions p
    join identity.users u on u.uid = case when p.user_a = ops.current_uid() then p.user_b else p.user_a end
   where ops.current_uid() in (p.user_a, p.user_b) and p.status = 'ALLOWED'
  union all
  select 'b' || b.id, 'BLOCKED', u.display_name, u.handle, b.created_at
    from ops.request_blocks b
    join identity.users u on u.uid = b.blocked_uid
   where b.blocker_uid = ops.current_uid()
  order by 5 desc;
$$;

create function ops.revoke_request_permission(p_id bigint)
returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_other text;
begin
  update ops.request_permissions p set status = 'REVOKED', revoked_by = v_me, revoked_at = now()
   where p.id = p_id and v_me in (p.user_a, p.user_b) and p.status = 'ALLOWED'
  returning case when p.user_a = v_me then p.user_b else p.user_a end into v_other;
  if v_other is null then return false; end if;
  perform ops.request_audit(v_me, 'request_permission.revoke', v_other, '{}'::jsonb);
  return true;
end;
$$;

create function ops.unblock_requester(p_id bigint)
returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_other text;
begin
  delete from ops.request_blocks b where b.id = p_id and b.blocker_uid = v_me returning b.blocked_uid into v_other;
  if v_other is null then return false; end if;
  perform ops.request_audit(v_me, 'request.unblock', v_other, '{}'::jsonb);
  return true;
end;
$$;

create function ops.money_request_email_facts(p_request_id text)
returns table(requester_uid text, payer_uid text, requester_name text, requester_handle text, payer_name text, payer_handle text, amount text, note text, status text, permission text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select r.requester_uid, r.payer_uid, ru.display_name, ru.handle, pu.display_name, pu.handle, r.amount::text, r.note, r.status, r.permission
    from ops.money_requests r
    join identity.users ru on ru.uid = r.requester_uid
    join identity.users pu on pu.uid = r.payer_uid
   where r.request_id = p_request_id
     and ops.current_uid() is not null
     and ops.current_uid() in (r.requester_uid, r.payer_uid);
$$;

create function ops.money_request_submittable(p_op_id text)
returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_req ops.money_requests%rowtype;
  v_op ops.prepared_ops%rowtype;
begin
  select * into v_op from ops.prepared_ops p where p.op_id = p_op_id and p.uid = v_me;
  if not found then return false; end if;
  if v_op.money_request_id is null then return true; end if;
  select * into v_req from ops.money_requests m where m.request_id = v_op.money_request_id for update;
  return found
     and v_req.payer_uid = v_me
     and v_req.status = 'PENDING'
     and v_req.permission in ('NOT_NEEDED', 'ALLOWED', 'ALLOWED_ONCE')
     and coalesce(v_req.opened_at, v_req.created_at) > now() - (select pol.payable_ttl from ops.request_policy pol limit 1)
     and v_op.receiver = v_req.requester_account
     and v_op.amount = v_req.amount
     and not exists (select 1 from ops.request_blocks b where b.blocker_uid = v_req.payer_uid and b.blocked_uid = v_req.requester_uid)
     and not exists (select 1 from ops.prepared_ops p where p.money_request_id = v_req.request_id and p.op_id <> p_op_id and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN', 'SETTLED'));
end;
$$;

drop function ops.settle_money_request(text);
create function ops.settle_money_request(p_op_id text, p_tx_hash text)
returns table(request_id text, requester_uid text, payer_name text, payer_handle text, amount text, note text)
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_op ops.prepared_ops%rowtype;
  v_req ops.money_requests%rowtype;
  v_receipt text;
  v_log integer;
begin
  select * into v_op from ops.prepared_ops p where p.op_id = p_op_id and p.status = 'SETTLED' and p.money_request_id is not null;
  if not found then return; end if;
  select * into v_req from ops.money_requests m where m.request_id = v_op.money_request_id for update;
  if not found or v_req.status <> 'PENDING' or v_req.permission not in ('NOT_NEEDED', 'ALLOWED', 'ALLOWED_ONCE') then return; end if;
  if v_op.uid <> v_req.payer_uid or v_op.receiver <> v_req.requester_account or v_op.amount <> v_req.amount or p_tx_hash is null then
    perform ops.request_audit('system', 'request.settle_rejected', v_req.request_id, jsonb_build_object('op_id', p_op_id, 'reason', 'op does not match request'));
    return;
  end if;
  select e.receipt_id, e.log_index into v_receipt, v_log
    from chain.events e
   where e.kind = 'ft_transfer'
     and e.tx_hash = p_tx_hash
     and e.from_account = v_op.account_id
     and e.to_account = v_req.requester_account
     and e.token = v_op.canonical -> 'op' ->> 'token'
     and e.amount = v_req.amount
     and not exists (select 1 from ops.money_requests x where x.paid_receipt_id = e.receipt_id and x.paid_log_index = e.log_index)
   order by e.log_index
   limit 1;
  if v_receipt is null then
    perform ops.request_audit('system', 'request.settle_rejected', v_req.request_id, jsonb_build_object('op_id', p_op_id, 'tx_hash', p_tx_hash, 'reason', 'no matching transfer'));
    return;
  end if;
  update ops.money_requests set status = 'PAID', paid_op_id = p_op_id, paid_receipt_id = v_receipt, paid_log_index = v_log, updated_at = now()
   where ops.money_requests.request_id = v_req.request_id;
  insert into ops.notifications(uid, kind, ref) values (v_req.requester_uid, 'MONEY_REQUEST_PAID', v_req.request_id) on conflict do nothing;
  return query
    select v_req.request_id, v_req.requester_uid, u.display_name, u.handle, v_req.amount::text, v_req.note
      from identity.users u where u.uid = v_req.payer_uid;
end;
$$;

grant execute on function ops.create_money_request(text, text, numeric, text), ops.respond_money_request(text, text), ops.payable_money_request(text),
  ops.money_request_submittable(text), ops.my_money_requests(integer), ops.my_request_contacts(), ops.revoke_request_permission(bigint),
  ops.unblock_requester(bigint), ops.money_request_email_facts(text) to obiba_app;
grant execute on function ops.settle_money_request(text, text) to obiba_indexer;
