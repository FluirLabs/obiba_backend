import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type Redis from 'ioredis';
import { APP_CONFIG, appOrigin, type AppConfig } from '../config';
import { appError } from '../errors';
import { REDIS } from '../infra/tokens';

const CHALLENGE_TTL_SECONDS = 300;
const CEREMONY_TIMEOUT_MS = 120_000;
const ALGORITHMS = [-8, -7, -257];
const TRANSPORTS = new Set<AuthenticatorTransportFuture>(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

export type Ceremony = 'register' | 'signin';

export interface StoredCredential {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
}

export interface VerifiedRegistration {
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: string[];
  aaguid: string | null;
  backedUp: boolean;
}

interface PendingChallenge {
  challenge: string;
  bound: string | null;
}

export function toTransports(values: readonly string[] | undefined): AuthenticatorTransportFuture[] {
  return (values ?? []).filter((t): t is AuthenticatorTransportFuture => TRANSPORTS.has(t as AuthenticatorTransportFuture));
}

export function newPrfSalt(): string {
  return randomBytes(32).toString('base64url');
}

export function newUserHandle(): string {
  return randomBytes(16).toString('base64url');
}

@Injectable()
export class WebAuthnService {
  readonly origin: string;
  readonly rpId: string;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(REDIS) private readonly redis: Redis,
  ) {
    this.origin = appOrigin(config);
    this.rpId = new URL(this.origin).hostname;
  }

  private key(ceremony: Ceremony, uid: string): string {
    return `webauthn:${ceremony}:${uid}`;
  }

  private async remember(ceremony: Ceremony, uid: string, challenge: string, bound: string | null): Promise<void> {
    const value: PendingChallenge = { challenge, bound };
    const ok = await this.redis.set(this.key(ceremony, uid), JSON.stringify(value), 'EX', CHALLENGE_TTL_SECONDS).catch(() => null);
    if (ok !== 'OK') throw appError('SERVICE_PAUSED');
  }

  async consume(ceremony: Ceremony, uid: string): Promise<PendingChallenge> {
    let raw: string | null;
    try {
      raw = await this.redis.getdel(this.key(ceremony, uid));
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    if (!raw) throw appError('EXPIRED');
    try {
      const parsed = JSON.parse(raw) as PendingChallenge;
      if (typeof parsed.challenge !== 'string') throw new Error('shape');
      return { challenge: parsed.challenge, bound: typeof parsed.bound === 'string' ? parsed.bound : null };
    } catch {
      throw appError('EXPIRED');
    }
  }

  async registrationOptions(uid: string, user: { handle: string; name: string; displayName: string }, exclude: StoredCredential[], prfSalt: string): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const options = await generateRegistrationOptions({
      rpName: 'Obiba',
      rpID: this.rpId,
      userName: user.name,
      userID: Buffer.from(user.handle, 'base64url'),
      userDisplayName: user.displayName,
      timeout: CEREMONY_TIMEOUT_MS,
      attestationType: 'none',
      excludeCredentials: exclude.map((c) => ({ id: c.credentialId, transports: toTransports(c.transports) })),
      authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      supportedAlgorithmIDs: ALGORITHMS,
    });
    await this.remember('register', uid, options.challenge, prfSalt);
    return options;
  }

  async verifyRegistration(uid: string, response: RegistrationResponseJSON): Promise<VerifiedRegistration & { prfSalt: string }> {
    const { challenge, bound } = await this.consume('register', uid);
    if (!bound) throw appError('EXPIRED');
    let result;
    try {
      result = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
    } catch {
      throw appError('PASSKEY_REJECTED');
    }
    if (!result.verified || !result.registrationInfo.userVerified) throw appError('PASSKEY_REJECTED');
    const info = result.registrationInfo;
    return {
      credentialId: info.credential.id,
      publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
      counter: info.credential.counter,
      transports: toTransports(info.credential.transports),
      aaguid: /^[0-9a-f-]{36}$/.test(info.aaguid) && info.aaguid !== '00000000-0000-0000-0000-000000000000' ? info.aaguid : null,
      backedUp: info.credentialBackedUp,
      prfSalt: bound,
    };
  }

  async authenticationOptions(uid: string, allow: StoredCredential[], bound: string): Promise<PublicKeyCredentialRequestOptionsJSON> {
    const options = await generateAuthenticationOptions({
      rpID: this.rpId,
      allowCredentials: allow.map((c) => ({ id: c.credentialId, transports: toTransports(c.transports) })),
      userVerification: 'required',
      timeout: CEREMONY_TIMEOUT_MS,
    });
    await this.remember('signin', uid, options.challenge, bound);
    return options;
  }

  async verifyAuthentication(expected: PendingChallenge, response: AuthenticationResponseJSON, credential: StoredCredential): Promise<number> {
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response,
        expectedChallenge: expected.challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        credential: {
          id: credential.credentialId,
          publicKey: Buffer.from(credential.publicKey, 'base64url'),
          counter: credential.counter,
          transports: toTransports(credential.transports),
        },
      });
    } catch {
      throw appError('PASSKEY_REJECTED');
    }
    if (!result.verified || !result.authenticationInfo.userVerified) throw appError('PASSKEY_REJECTED');
    return result.authenticationInfo.newCounter;
  }
}
