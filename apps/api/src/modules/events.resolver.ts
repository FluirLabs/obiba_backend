import { Context, Resolver, Subscription } from '@nestjs/graphql';
import { AccountEvent } from '../graphql/types';
import { RealtimeHub } from '../infra/realtime';
import { identityOf, type ObibaRequest } from '../security/request';

const TRANSACTION_KINDS = new Set(['op', 'withdrawal', 'invoice'] as const);
const DEPOSIT_KINDS = new Set(['deposit'] as const);
const BALANCE_KINDS = new Set(['balance'] as const);
const DEVICE_KINDS = new Set(['device'] as const);

@Resolver()
export class EventsResolver {
  constructor(private readonly hub: RealtimeHub) {}

  @Subscription(() => AccountEvent)
  accountEvents(@Context('req') req: ObibaRequest) {
    return this.hub.stream(identityOf(req).uid, 'accountEvents');
  }

  @Subscription(() => AccountEvent)
  transactionUpdated(@Context('req') req: ObibaRequest) {
    return this.hub.stream(identityOf(req).uid, 'transactionUpdated', TRANSACTION_KINDS);
  }

  @Subscription(() => AccountEvent)
  depositUpdated(@Context('req') req: ObibaRequest) {
    return this.hub.stream(identityOf(req).uid, 'depositUpdated', DEPOSIT_KINDS);
  }

  @Subscription(() => AccountEvent)
  balanceChanged(@Context('req') req: ObibaRequest) {
    return this.hub.stream(identityOf(req).uid, 'balanceChanged', BALANCE_KINDS);
  }

  @Subscription(() => AccountEvent)
  deviceLinkUpdated(@Context('req') req: ObibaRequest) {
    return this.hub.stream(identityOf(req).uid, 'deviceLinkUpdated', DEVICE_KINDS);
  }
}
