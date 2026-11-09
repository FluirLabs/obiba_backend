import { Inject, Injectable, Logger, type OnApplicationShutdown } from '@nestjs/common';
import Redis from 'ioredis';
import { USER_CHANNEL_PREFIX, parseUserEvent, type UserEvent } from '@obiba/domain';
import { APP_CONFIG, type AppConfig } from '../config';
import { appError } from '../errors';

const MAX_STREAMS_PER_USER = 5;
const MAX_BUFFERED = 100;
const HEARTBEAT_MS = 25_000;

type Listener = (event: UserEvent) => void;

@Injectable()
export class RealtimeHub implements OnApplicationShutdown {
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly closers = new Set<() => void>();
  private readonly log = new Logger('Realtime');

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  private connection(): Redis {
    if (this.subscriber) return this.subscriber;
    const sub = new Redis(this.config.REDIS_URL, { maxRetriesPerRequest: null, connectTimeout: 5_000 });
    sub.on('error', () => this.log.warn('realtime redis connection error'));
    sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      if (!channel.startsWith(USER_CHANNEL_PREFIX)) return;
      const set = this.listeners.get(channel.slice(USER_CHANNEL_PREFIX.length));
      if (!set) return;
      const event = parseUserEvent(message);
      if (!event) return;
      for (const l of set) l(event);
    });
    void sub.psubscribe(`${USER_CHANNEL_PREFIX}*`).catch(() => this.log.warn('realtime subscribe failed'));
    this.subscriber = sub;
    return sub;
  }

  stream<F extends string>(uid: string, field: F, kinds?: ReadonlySet<UserEvent['kind']>): AsyncIterableIterator<Record<F, UserEvent>> {
    const set = this.listeners.get(uid) ?? new Set<Listener>();
    if (set.size >= MAX_STREAMS_PER_USER) throw appError('RATE_LIMITED');
    this.connection();
    this.listeners.set(uid, set);
    const queue: UserEvent[] = [];
    let wake: ((r: IteratorResult<Record<F, UserEvent>>) => void) | null = null;
    let done = false;
    const wrap = (event: UserEvent) => ({ [field]: event }) as Record<F, UserEvent>;
    const push = (event: UserEvent) => {
      if (done) return;
      if (kinds && event.status !== 'HEARTBEAT' && !kinds.has(event.kind)) return;
      if (wake) {
        const w = wake;
        wake = null;
        w({ value: wrap(event), done: false });
        return;
      }
      if (queue.length >= MAX_BUFFERED) queue.shift();
      queue.push(event);
    };
    const heartbeat = setInterval(() => push({ kind: 'account', id: 'heartbeat', status: 'HEARTBEAT' }), HEARTBEAT_MS);
    set.add(push);
    const close = () => {
      if (done) return;
      done = true;
      this.closers.delete(close);
      clearInterval(heartbeat);
      set.delete(push);
      if (set.size === 0) this.listeners.delete(uid);
      if (wake) {
        const w = wake;
        wake = null;
        w({ value: undefined, done: true });
      }
    };
    this.closers.add(close);
    const iterator: AsyncIterableIterator<Record<F, UserEvent>> = {
      next: () => {
        if (done) return Promise.resolve({ value: undefined, done: true });
        const event = queue.shift();
        if (event) return Promise.resolve({ value: wrap(event), done: false });
        return new Promise((resolve) => {
          wake = resolve;
        });
      },
      return: () => {
        close();
        return Promise.resolve({ value: undefined, done: true });
      },
      throw: (err?: unknown) => {
        close();
        return Promise.reject(err);
      },
      [Symbol.asyncIterator]() {
        return iterator;
      },
    };
    return iterator;
  }

  listenerCount(uid: string): number {
    return this.listeners.get(uid)?.size ?? 0;
  }

  onApplicationShutdown(): void {
    for (const close of [...this.closers]) close();
    this.subscriber?.disconnect();
    this.subscriber = null;
    this.listeners.clear();
  }
}
