import { createPrivateKey, sign as nodeSign } from 'node:crypto';

export function localGuardianSign(seedHex: string, digest: Buffer): Buffer {
  const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seedHex, 'hex')]);
  return nodeSign(null, digest, createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
}
