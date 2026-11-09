import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { PG_POOL } from './tokens';

export interface AuditEntry {
  actor: string;
  action: string;
  target?: string;
  outcome: 'ALLOWED' | 'DENIED' | 'FAILED';
  requestId?: string;
  details?: Record<string, string | number | boolean | null>;
}

const SQL = 'insert into audit.log(actor, action, target, outcome, request_id, details) values ($1, $2, $3, $4, $5, $6)';

@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async record(entry: AuditEntry, client?: PoolClient): Promise<void> {
    const params = [entry.actor, entry.action, entry.target ?? null, entry.outcome, entry.requestId ?? null, JSON.stringify(entry.details ?? {})];
    try {
      await (client ?? this.pool).query(SQL, params);
    } catch (err) {
      if (client) throw err;
      this.log.error(`audit write failed for ${entry.action}`);
    }
  }
}
