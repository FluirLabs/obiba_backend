alter table ops.account_calls drop constraint account_calls_method_check;
alter table ops.account_calls add constraint account_calls_method_check
  check (method in ('set_limit', 'add_token'));
