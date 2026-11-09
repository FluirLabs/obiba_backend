import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Params } from 'nestjs-pino';
import type { AppConfig } from './config';

const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-goog-iap-jwt-assertion"]',
  'res.headers["set-cookie"]',
  '*.signedDelegate',
  '*.idempotencyKey',
  '*.password',
  '*.token',
  '*.id_token',
  '*.phone',
  '*.phone_e164',
  '*.email',
];

export function loggerParams(config: AppConfig, destination?: NodeJS.WritableStream): Params {
  return {
    pinoHttp: [
      {
        level: config.LOG_LEVEL,
        redact: { paths: REDACT_PATHS, censor: '[redacted]' },
        genReqId: (req: IncomingMessage) => {
          const incoming = req.headers['x-request-id'];
          return typeof incoming === 'string' && REQUEST_ID.test(incoming) ? incoming : randomUUID();
        },
        serializers: {
          req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, path: String(req.url).split('?')[0] }),
          res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
        },
        autoLogging: { ignore: (req: IncomingMessage) => req.url === '/healthz' },
        customProps: (req: IncomingMessage & { identity?: { uid: string } }) => (req.identity ? { uid: req.identity.uid } : {}),
      },
      destination as never,
    ].filter(Boolean) as never,
  };
}
