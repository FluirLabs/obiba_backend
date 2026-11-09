import type { PoolClient } from 'pg';
import { mirrorRealCredits } from '@obiba/db';

export function ensureSandboxMirror(c: PoolClient, uid: string): Promise<number> {
  return mirrorRealCredits(c, uid);
}
