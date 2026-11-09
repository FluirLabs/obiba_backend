import { OAuth2Client } from 'google-auth-library';

export abstract class IapVerifier {
  abstract verify(assertion: string | undefined): Promise<string>;
}

export class DevIapVerifier extends IapVerifier {
  constructor(private readonly staff: Set<string>) {
    super();
  }

  async verify(assertion: string | undefined): Promise<string> {
    const email = assertion?.startsWith('dev:') ? assertion.slice(4).toLowerCase() : '';
    if (!this.staff.has(email)) throw new Error('not a local staff login');
    return email;
  }
}

export class GoogleIapVerifier extends IapVerifier {
  private readonly client = new OAuth2Client();

  constructor(private readonly audience: string) {
    super();
  }

  async verify(assertion: string | undefined): Promise<string> {
    if (!assertion || assertion.length > 8192) throw new Error('missing IAP assertion');
    const keys = await this.client.getIapPublicKeysAsync();
    const ticket = await this.client.verifySignedJwtWithCertsAsync(assertion, keys.pubkeys, this.audience, ['https://cloud.google.com/iap']);
    const email = ticket.getPayload()?.email;
    if (typeof email !== 'string') throw new Error('IAP assertion has no email');
    return email.toLowerCase();
  }
}
