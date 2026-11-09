grant select on chain.accounts, ops.prepared_ops, ops.invoices, ops.deposits to obiba_indexer;
grant update (status, updated_at) on ops.prepared_ops to obiba_indexer;
grant update (status) on ops.invoices to obiba_indexer;
grant update (status, credited_event, updated_at) on ops.deposits to obiba_indexer;
grant usage on schema ops to obiba_indexer;
grant execute on function ledger.close_hold(text, text) to obiba_indexer;
grant insert on audit.log to obiba_indexer;
grant usage on sequence audit.log_id_seq to obiba_indexer;

create policy indexer_all on chain.accounts for select to obiba_indexer using (true);
create policy indexer_all on ops.prepared_ops for all to obiba_indexer using (true) with check (true);
create policy indexer_all on ops.invoices for all to obiba_indexer using (true) with check (true);
create policy indexer_all on ops.deposits for all to obiba_indexer using (true) with check (true);

create table chain.ingested_txs (
  tx_hash text primary key check (length(tx_hash) between 32 and 64),
  sender text not null,
  ingested_at timestamptz not null default now()
);
grant select, insert on chain.ingested_txs to obiba_indexer;

grant insert on infra.outbox to obiba_worker;
grant usage on sequence infra.outbox_id_seq to obiba_worker;
grant update (status, initial) on identity.devices to obiba_worker;
grant execute on function ledger.place_hold(text, bigint, numeric, timestamptz) to obiba_worker;

create function ops.provisioning_target(p_uid text)
returns table(uid text, pilot_allowed boolean, status text, device_key text, device_status text, account_id text, account_status text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select u.uid, u.pilot_allowed, u.status, d.public_key, d.status, a.account_id, a.status
    from identity.users u
    left join identity.devices d on d.uid = u.uid and d.initial
    left join chain.accounts a on a.uid = u.uid
   where u.uid = p_uid;
$$;
grant execute on function ops.provisioning_target(text) to obiba_worker;

alter table ops.prepared_ops add column relay_tx_hashes text[] not null default '{}';
alter table ops.prepared_ops add column relay_attempts integer not null default 0 check (relay_attempts between 0 and 10);
