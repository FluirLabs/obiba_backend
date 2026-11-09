create table ops.reconciliation_runs (
  id bigserial primary key,
  account_id text not null,
  token text not null,
  ledger_posted numeric(39, 0) not null,
  chain_balance numeric(39, 0) not null,
  matched boolean not null,
  checked_at timestamptz not null default now()
);
create index reconciliation_mismatches on ops.reconciliation_runs(checked_at desc) where not matched;
grant select, insert on ops.reconciliation_runs to obiba_worker;
grant usage on sequence ops.reconciliation_runs_id_seq to obiba_worker;
grant select on ops.reconciliation_runs to obiba_ops;
grant select on ledger.accounts, ledger.balances, ledger.holds to obiba_worker;
grant update (status) on chain.accounts to obiba_worker;

create function ledger.expired_holds(p_limit integer)
returns table(op_ref text)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select h.op_ref from ledger.holds h
   where h.status = 'ACTIVE' and h.expires_at < now()
     and not exists (
       select 1 from ops.prepared_ops p
        where 'op:' || p.op_id = h.op_ref and p.status in ('SUBMITTED', 'RELAYED', 'UNKNOWN'))
   order by h.expires_at limit least(greatest(p_limit, 1), 500);
$$;
grant execute on function ledger.expired_holds(integer) to obiba_worker;
