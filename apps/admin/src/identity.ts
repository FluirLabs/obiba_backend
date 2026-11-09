import { initializeApp, type App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

export interface IdentityAdmin {
  replacePhoneFactor(uid: string, phoneNumber: string): Promise<void>;
  revokeSessions(uid: string): Promise<void>;
}

export class FirebaseIdentityAdmin implements IdentityAdmin {
  private readonly app: App;

  constructor(projectId: string) {
    this.app = initializeApp({ projectId }, `admin-${process.pid}`);
  }

  async replacePhoneFactor(uid: string, phoneNumber: string): Promise<void> {
    await getAuth(this.app).updateUser(uid, { multiFactor: { enrolledFactors: [{ factorId: 'phone', phoneNumber, displayName: 'Mobile' }] } });
  }

  async revokeSessions(uid: string): Promise<void> {
    await getAuth(this.app).revokeRefreshTokens(uid);
  }
}
