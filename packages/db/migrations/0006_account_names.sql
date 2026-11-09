alter table identity.users add column account_name text unique
  check (length(account_name) between 3 and 20 and account_name ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and account_name !~ '^u-[a-z0-9]{10}$');

alter table chain.accounts drop constraint accounts_account_id_check;
alter table chain.accounts add constraint accounts_account_id_check
  check (length(account_id) <= 64 and account_id ~ '^[a-z0-9]+(-[a-z0-9]+)*\.[a-z0-9.-]+$');

create function chain.enforce_account_name()
returns trigger
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_name text;
begin
  select u.account_name into v_name from identity.users u where u.uid = new.uid;
  if v_name is not null and split_part(new.account_id, '.', 1) <> v_name then
    raise exception 'account id does not match the chosen account name';
  end if;
  if v_name is null and new.account_id !~ '^u-[a-z0-9]{10}\.' then
    raise exception 'account id needs a chosen account name';
  end if;
  return new;
end;
$$;
create trigger accounts_match_name before insert or update of account_id on chain.accounts
  for each row execute function chain.enforce_account_name();

create function identity.account_name_taken(p_name text)
returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select ops.current_uid() is null
      or exists (select 1 from identity.users u where u.account_name = lower(p_name))
      or exists (select 1 from chain.accounts a where split_part(a.account_id, '.', 1) = lower(p_name));
$$;
grant execute on function identity.account_name_taken(text) to obiba_app;

revoke insert, update on identity.users from obiba_app;
grant insert (uid, display_name, phone_e164, email, handle, account_name) on identity.users to obiba_app;

drop function ops.provisioning_target(text);
create function ops.provisioning_target(p_uid text)
returns table(uid text, pilot_allowed boolean, status text, device_key text, device_status text, account_id text, account_status text, account_name text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select u.uid, u.pilot_allowed, u.status, d.public_key, d.status, a.account_id, a.status, u.account_name
    from identity.users u
    left join identity.devices d on d.uid = u.uid and d.initial
    left join chain.accounts a on a.uid = u.uid
   where u.uid = p_uid;
$$;
grant execute on function ops.provisioning_target(text) to obiba_worker;
