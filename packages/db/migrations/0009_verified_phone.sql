alter table identity.users add column phone_verified_at timestamptz;

create unique index users_verified_phone on identity.users(phone_e164) where phone_verified_at is not null;

create function identity.mark_phone_verified(p_phone text)
returns boolean
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  n integer;
begin
  update identity.users set phone_verified_at = coalesce(phone_verified_at, now())
   where uid = ops.current_uid() and phone_e164 = p_phone;
  get diagnostics n = row_count;
  return n = 1;
end;
$$;
revoke all on function identity.mark_phone_verified(text) from public;
grant execute on function identity.mark_phone_verified(text) to obiba_app;

create or replace function ops.resolve_recipient_by_phone(p_phone text)
returns table(display_name text, account_id text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select max(u.display_name), max(a.account_id)
    from identity.users u join chain.accounts a on a.uid = u.uid
   where u.phone_e164 = p_phone and u.phone_verified_at is not null and u.status = 'active' and a.status = 'active'
     and ops.current_uid() is not null and p_phone ~ '^\+233[0-9]{9}$'
  having count(*) = 1;
$$;
