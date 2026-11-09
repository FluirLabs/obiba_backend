import { createPrivateKey, sign as nodeSign } from 'node:crypto';
import { KeyManagementServiceClient } from '@google-cloud/kms';
import { Inject, Injectable } from '@nestjs/common';
import { verifyEd25519 } from '@obiba/domain';
import { APP_CONFIG, type AppConfig } from '../config';

export abstract class InvoiceSigner {
  abstract sign(digest: Buffer): Promise<Buffer>;
}

function checked(signature: Buffer, digest: Buffer, publicKey: string): Buffer {
  if (signature.length !== 64 || !verifyEd25519(publicKey, digest, signature)) {
    throw new Error('invoice signer produced a signature that does not verify against INVOICE_PUBLIC_KEY');
  }
  return signature;
}

@Injectable()
export class KmsInvoiceSigner extends InvoiceSigner {
  private readonly client = new KeyManagementServiceClient();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  async sign(digest: Buffer): Promise<Buffer> {
    const [res] = await this.client.asymmetricSign({ name: this.config.INVOICE_KMS_KEY, data: digest }, { timeout: 10_000 });
    const sig = Buffer.from(res.signature as Uint8Array);
    return checked(sig, digest, this.config.INVOICE_PUBLIC_KEY);
  }
}

@Injectable()
export class LocalInvoiceSigner extends InvoiceSigner {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
    if (config.NODE_ENV === 'production') throw new Error('local invoice signer is not allowed in production');
  }

  async sign(digest: Buffer): Promise<Buffer> {
    const seed = Buffer.from(this.config.INVOICE_LOCAL_SEED_HEX ?? '', 'hex');
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const key = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
    return checked(nodeSign(null, digest, key), digest, this.config.INVOICE_PUBLIC_KEY);
  }
}
