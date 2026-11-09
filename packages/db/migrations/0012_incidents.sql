create table ops.incidents (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 4 and 140),
  severity text not null check (severity in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW')),
  status text not null default 'OPEN' check (status in ('OPEN', 'ACKNOWLEDGED', 'INVESTIGATING', 'RESOLVED')),
  summary text not null check (length(summary) between 8 and 2000),
  signal_key text check (signal_key ~ '^[a-z_-]{2,32}$'),
  resources text[] not null default '{}' check (cardinality(resources) <= 20),
  owner text,
  declared_by text not null,
  acknowledged_by text,
  acknowledged_at timestamptz,
  resolved_by text,
  resolved_at timestamptz,
  resolution text check (length(resolution) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (status = 'OPEN' or (acknowledged_by is not null and owner is not null)),
  check ((status = 'RESOLVED') = (resolved_by is not null and resolution is not null and resolved_at is not null))
);

create table ops.incident_events (
  id bigserial primary key,
  incident_id uuid not null references ops.incidents(id),
  at timestamptz not null default now(),
  actor text not null,
  kind text not null check (kind in ('DECLARED', 'ACKNOWLEDGED', 'INVESTIGATING', 'NOTE', 'RESOLVED')),
  body text not null check (length(body) between 1 and 2000),
  evidence text check (length(evidence) <= 500)
);

create index incidents_status_idx on ops.incidents (status, created_at desc);
create index incident_events_incident_idx on ops.incident_events (incident_id, id);

grant select, insert on ops.incidents, ops.incident_events to obiba_ops;
grant update (status, owner, acknowledged_by, acknowledged_at, resolved_by, resolved_at, resolution, updated_at) on ops.incidents to obiba_ops;
grant usage on sequence ops.incident_events_id_seq to obiba_ops;
