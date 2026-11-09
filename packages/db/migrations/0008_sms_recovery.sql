alter table ops.recoveries drop constraint if exists recoveries_method_check;
alter table ops.recoveries add constraint recoveries_method_check check (method in ('TOTP', 'KIT', 'SMS'));
