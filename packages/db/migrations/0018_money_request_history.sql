drop function ops.my_money_requests(integer);
create function ops.my_money_requests(p_limit integer)
returns table(request_id text, direction text, counterparty_name text, counterparty_handle text, counterparty_account text, amount text, note text, status text, permission text, paying boolean, created_at timestamptz, updated_at timestamptz, earlier_requests integer)
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
         r.created_at, r.updated_at,
         (select count(*)::integer from ops.money_requests e
           where e.requester_uid = r.requester_uid and e.payer_uid = r.payer_uid and e.created_at < r.created_at)
    from ops.money_requests r
    join identity.users u on u.uid = case when r.requester_uid = ops.current_uid() then r.payer_uid else r.requester_uid end
   where r.requester_uid = ops.current_uid() or r.payer_uid = ops.current_uid()
   order by r.created_at desc
   limit least(greatest(p_limit, 1), 100);
end;
$$;

grant execute on function ops.my_money_requests(integer) to obiba_app;
