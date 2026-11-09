import { CanActivate, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type Redis from 'ioredis';
import { killSwitchKey, type KillSwitchName } from '@obiba/domain';
import { appError } from '../errors';
import { REDIS } from '../infra/tokens';

export const KILL_SWITCH = 'obiba:kill-switch';
export const KillSwitch = (...names: KillSwitchName[]) => SetMetadata(KILL_SWITCH, names);

export async function switchedOff(redis: Redis, names: readonly KillSwitchName[]): Promise<boolean> {
  if (names.length === 0) return false;
  try {
    return (await redis.exists(...names.map(killSwitchKey))) > 0;
  } catch {
    return true;
  }
}

@Injectable()
export class KillSwitchGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const names = this.reflector.getAllAndOverride<KillSwitchName[]>(KILL_SWITCH, [ctx.getHandler(), ctx.getClass()]) ?? [];
    if (await switchedOff(this.redis, names)) throw appError('SERVICE_PAUSED');
    return true;
  }
}
