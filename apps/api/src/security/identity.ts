import { Inject, Injectable } from '@nestjs/common';
import type { App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import type Redis from 'ioredis';
import { REDIS } from '../infra/tokens';

export interface VerifiedIdentity {
  uid: string;
  email: string;
  emailVerified: boolean;
  authTime: number;
  secondFactor: string | null;
  provider: string;
}

export class InvalidTokenError extends Error {}

export abstract class IdTokenVerifier {
  abstract verify(token: string): Promise<VerifiedIdentity>;
  abstract revokeSessions(uid: string): Promise<void>;
  abstract verifiedPhone(uid: string): Promise<string | null>;
}

export const FIREBASE_APP = Symbol('FIREBASE_APP');
const REVOCATION_TTL_SECONDS = 60;

@Injectable()
export class FirebaseIdTokenVerifier extends IdTokenVerifier {
  constructor(
    @Inject(FIREBASE_APP) private readonly app: App,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    super();
  }

  async verify(token: string): Promise<VerifiedIdentity> {
    const auth = getAuth(this.app);
    let decoded;
    try {
      decoded = await auth.verifyIdToken(token, false);
    } catch {
      throw new InvalidTokenError('invalid token');
    }
    const key = `rev:${decoded.uid}`;
    const cached = await this.redis.get(key).catch(() => null);
    if (cached === 'revoked') throw new InvalidTokenError('revoked');
    if (cached !== `ok:${decoded.auth_time}`) {
      try {
        await auth.verifyIdToken(token, true);
        await this.redis.set(key, `ok:${decoded.auth_time}`, 'EX', REVOCATION_TTL_SECONDS).catch(() => undefined);
      } catch {
        await this.redis.set(key, 'revoked', 'EX', REVOCATION_TTL_SECONDS).catch(() => undefined);
        throw new InvalidTokenError('revoked');
      }
    }
    return {
      uid: decoded.uid,
      email: decoded.email ?? '',
      emailVerified: decoded.email_verified === true,
      authTime: decoded.auth_time,
      secondFactor: decoded.firebase?.sign_in_second_factor ?? null,
      provider: decoded.firebase?.sign_in_provider ?? 'unknown',
    };
  }

  async verifiedPhone(uid: string): Promise<string | null> {
    const user = await getAuth(this.app).getUser(uid);
    const factor = user.multiFactor?.enrolledFactors.find((f) => f.factorId === 'phone') as { phoneNumber?: string } | undefined;
    return factor?.phoneNumber ?? null;
  }

  async revokeSessions(uid: string): Promise<void> {
    await getAuth(this.app).revokeRefreshTokens(uid);
    await this.redis.del(`rev:${uid}`).catch(() => undefined);
  }
}
