import { initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { OAuth2Client } from 'google-auth-library';
import type { GuardianIdentity, UserTokenVerifier } from './guardian';

export class FirebaseUserVerifier implements UserTokenVerifier {
  private readonly app: App;

  constructor(projectId: string) {
    this.app = initializeApp({ projectId }, `guardian-${process.pid}`);
  }

  async verify(idToken: string): Promise<GuardianIdentity> {
    const d = await getAuth(this.app).verifyIdToken(idToken, true);
    return {
      uid: d.uid,
      emailVerified: d.email_verified === true,
      authTime: d.auth_time,
      secondFactor: d.firebase?.sign_in_second_factor ?? null,
    };
  }

  async credentialsChangedAt(uid: string): Promise<Date | null> {
    const u = await getAuth(this.app).getUser(uid);
    const at = u.tokensValidAfterTime ? Date.parse(u.tokensValidAfterTime) : NaN;
    const created = Date.parse(u.metadata.creationTime);
    if (!Number.isFinite(at)) return null;
    return Number.isFinite(created) && Math.abs(at - created) < 60_000 ? null : new Date(at);
  }
}

export interface CallerVerifier {
  verify(authorizationHeader: string | undefined): Promise<string>;
}

export class DevCallerVerifier implements CallerVerifier {
  constructor(private readonly tokens: Map<string, string>) {}

  async verify(header: string | undefined): Promise<string> {
    const token = /^Bearer (\S{24,256})$/.exec(header ?? '')?.[1];
    const email = token ? this.tokens.get(token) : undefined;
    if (!email) throw new Error('caller not allowed');
    return email;
  }
}

export class GoogleCallerVerifier implements CallerVerifier {
  private readonly client = new OAuth2Client();

  constructor(
    private readonly audience: string,
    private readonly allowed: Set<string>,
  ) {}

  async verify(header: string | undefined): Promise<string> {
    const token = /^Bearer (\S{20,4096})$/.exec(header ?? '')?.[1];
    if (!token) throw new Error('missing caller token');
    const ticket = await this.client.verifyIdToken({ idToken: token, audience: this.audience });
    const p = ticket.getPayload();
    if (!p?.email || p.email_verified !== true || !this.allowed.has(p.email)) throw new Error('caller not allowed');
    return p.email;
  }
}
