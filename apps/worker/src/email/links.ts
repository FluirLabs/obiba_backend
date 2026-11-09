import { createHash } from 'node:crypto';
import type { App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface IssuedLink {
  link: string;
  uid: string;
  name: string | null;
  fingerprint: string;
}

export interface AccountLinks {
  passwordReset(email: string): Promise<IssuedLink | null>;
  verifyEmail(email: string): Promise<IssuedLink | null>;
  fingerprint(uid: string): Promise<string | null>;
}

function fingerprintOf(user: { passwordHash?: string; passwordSalt?: string }): string {
  return createHash('sha256').update(`${user.passwordHash ?? ''}:${user.passwordSalt ?? ''}`).digest('hex');
}

export function actionLink(appOrigin: string, mode: 'resetPassword' | 'verifyEmail', providerLink: string): string {
  const code = new URL(providerLink).searchParams.get('oobCode');
  if (!code) throw new Error('identity provider returned no action code');
  return `${appOrigin}/auth/action?mode=${mode}&oobCode=${encodeURIComponent(code)}`;
}

export class FirebaseAccountLinks implements AccountLinks {
  constructor(
    private readonly app: App,
    private readonly appOrigin: string,
  ) {}

  private async issue(email: string, mode: 'resetPassword' | 'verifyEmail'): Promise<IssuedLink | null> {
    const auth = getAuth(this.app);
    try {
      const user = await auth.getUserByEmail(email);
      const provider = mode === 'resetPassword' ? await auth.generatePasswordResetLink(email) : await auth.generateEmailVerificationLink(email);
      return { link: actionLink(this.appOrigin, mode, provider), uid: user.uid, name: user.displayName ?? null, fingerprint: fingerprintOf(user) };
    } catch (err) {
      if ((err as { code?: string }).code === 'auth/user-not-found') return null;
      throw new Error(`identity provider refused the link: ${(err as { code?: string }).code ?? 'unknown'}`);
    }
  }

  passwordReset(email: string): Promise<IssuedLink | null> {
    return this.issue(email, 'resetPassword');
  }

  verifyEmail(email: string): Promise<IssuedLink | null> {
    return this.issue(email, 'verifyEmail');
  }

  async fingerprint(uid: string): Promise<string | null> {
    try {
      return fingerprintOf(await getAuth(this.app).getUser(uid));
    } catch {
      return null;
    }
  }
}
