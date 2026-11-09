import { createPrivateKey, createPublicKey, sign as nodeSign } from 'node:crypto';
import { ed25519KeyString, verifyEd25519 } from '@obiba/domain';

export interface Signer {
  publicKey(): Promise<string>;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export class LocalSigner implements Signer {
  private readonly key: ReturnType<typeof createPrivateKey>;
  private readonly pub: string;

  constructor(seedHex: string, production = process.env.NODE_ENV === 'production') {
    if (production) throw new Error('local signing keys are not allowed in production');
    if (!/^[0-9a-f]{64}$/.test(seedHex)) throw new Error('seed must be 32 bytes hex');
    this.key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seedHex, 'hex')]), format: 'der', type: 'pkcs8' });
    const jwk = createPublicKey(this.key).export({ format: 'jwk' });
    this.pub = ed25519KeyString(Buffer.from(jwk.x!, 'base64url'));
  }

  async publicKey(): Promise<string> {
    return this.pub;
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    return nodeSign(null, message, this.key);
  }
}

interface KmsClientLike {
  asymmetricSign(req: { name: string; data: Uint8Array }, opts?: { timeout?: number }): Promise<[{ signature?: Uint8Array | string | null }]>;
  getPublicKey(req: { name: string }): Promise<[{ pem?: string | null; algorithm?: string | null }]>;
}

export class KmsSigner implements Signer {
  private cachedPub: string | null = null;

  constructor(
    private readonly client: KmsClientLike,
    private readonly keyVersionName: string,
  ) {}

  async publicKey(): Promise<string> {
    if (this.cachedPub) return this.cachedPub;
    const [res] = await this.client.getPublicKey({ name: this.keyVersionName });
    if (res.algorithm !== 'EC_SIGN_ED25519' || !res.pem) throw new Error('KMS key is not EC_SIGN_ED25519');
    const jwk = createPublicKey(res.pem).export({ format: 'jwk' });
    this.cachedPub = ed25519KeyString(Buffer.from(jwk.x!, 'base64url'));
    return this.cachedPub;
  }

  async sign(message: Uint8Array): Promise<Uint8Array> {
    const [res] = await this.client.asymmetricSign({ name: this.keyVersionName, data: message }, { timeout: 10_000 });
    const sig = typeof res.signature === 'string' ? Buffer.from(res.signature, 'base64') : Buffer.from(res.signature ?? []);
    if (sig.length !== 64 || !verifyEd25519(await this.publicKey(), message, sig)) {
      throw new Error('KMS returned a signature that does not verify');
    }
    return sig;
  }
}
