create table identity.released_handles (
  handle text primary key check (handle ~ '^[a-z0-9_]{3,24}$'),
  uid text not null references identity.users(uid),
  released_at timestamptz not null default now()
);
alter table identity.released_handles enable row level security;

create function identity.handle_taken(p_handle text)
returns boolean
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select ops.current_uid() is null
      or exists (select 1 from identity.users u where u.handle = lower(p_handle) and u.uid <> ops.current_uid())
      or exists (select 1 from identity.released_handles r
                  where r.handle = lower(p_handle) and r.uid <> ops.current_uid() and r.released_at > now() - interval '30 days');
$$;

create function identity.set_my_handle(p_handle text)
returns text
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_me text := ops.current_uid();
  v_new text := lower(p_handle);
  v_old text;
begin
  if v_me is null or v_new !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'invalid handle' using errcode = 'check_violation';
  end if;
  select u.handle into v_old from identity.users u where u.uid = v_me and u.status = 'active' for update;
  if not found then
    raise exception 'no active profile' using errcode = 'no_data_found';
  end if;
  if v_old is not distinct from v_new then
    return v_new;
  end if;
  if identity.handle_taken(v_new) then
    raise exception 'handle taken' using errcode = 'unique_violation';
  end if;
  update identity.users set handle = v_new, updated_at = now() where uid = v_me;
  delete from identity.released_handles where handle = v_new;
  if v_old is not null then
    insert into identity.released_handles(handle, uid) values (v_old, v_me)
      on conflict (handle) do update set uid = excluded.uid, released_at = now();
  end if;
  return v_new;
end;
$$;

grant execute on function identity.handle_taken(text), identity.set_my_handle(text) to obiba_app;
