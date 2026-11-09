import { Inject } from '@nestjs/common';
import { Args, Context, Query, Resolver } from '@nestjs/graphql';
import type { Pool } from 'pg';
import { withUserTx } from '@obiba/db';
import { APP_CONFIG, type AppConfig } from '../config';
import { appError } from '../errors';
import { IndicativeRate, Recipient, SpendingLimit } from '../graphql/types';
import { FxRates } from '../infra/fx';
import { NearChain } from '../infra/near-chain';
import { PG_POOL } from '../infra/tokens';
import { RateLimit } from '../security/decorators';
import { identityOf, type ObibaRequest } from '../security/request';
import { activeAccount } from './payments.resolver';
import { classifyRecipient, nsToIso, resolveRecipient } from './recipients';

@Resolver()
export class LookupResolver {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly chain: NearChain,
    private readonly fx: FxRates,
  ) {}

  @Query(() => IndicativeRate, { nullable: true })
  async indicativeRate(): Promise<IndicativeRate | null> {
    return this.fx.usdGhs();
  }

  @Query(() => Recipient, { nullable: true })
  @RateLimit('lookup')
  async recipient(@Context('req') req: ObibaRequest, @Args('query') query: string): Promise<Recipient | null> {
    const { uid } = identityOf(req);
    const q = classifyRecipient(query);
    return withUserTx(this.pool, uid, async (c) => {
      const self = await activeAccount(c, uid);
      const found = await resolveRecipient(c, this.chain, this.config, q);
      if (found?.accountId === self) throw appError('BAD_INPUT', 'query');
      return found;
    });
  }

  @Query(() => SpendingLimit)
  async spendingLimit(@Context('req') req: ObibaRequest): Promise<SpendingLimit> {
    const { uid } = identityOf(req);
    const accountId = await withUserTx(this.pool, uid, (c) => activeAccount(c, uid));
    let p;
    try {
      p = await this.chain.policy(accountId);
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    const limit = BigInt(p.effective_daily_limit);
    const spent = BigInt(p.spent_24h);
    const frozen = BigInt(p.frozen_until_ns ?? '0') > BigInt(Date.now()) * 1_000_000n ? nsToIso(p.frozen_until_ns) : null;
    return {
      currency: 'USD',
      dailyLimit: limit.toString(),
      spent24h: spent.toString(),
      remaining: (limit > spent ? limit - spent : 0n).toString(),
      maxOpAmount: p.max_op_amount,
      pendingLimit: p.pending_limit?.new_limit ?? null,
      pendingLimitEffectiveAt: nsToIso(p.pending_limit?.effective_at_ns),
      frozenUntil: frozen,
      recoveryExecutableAt: nsToIso(p.recovery?.executable_at_ns),
    };
  }
}
