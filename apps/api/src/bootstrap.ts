import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import type { AppConfig } from './config';

export const BODY_LIMIT = '64kb';

export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.useLogger(app.get(Logger));
  app.set('trust proxy', config.TRUSTED_PROXY_HOPS);
  app.disable('x-powered-by');
  app.useBodyParser('json', { limit: BODY_LIMIT, verify: (req: { url?: string; rawBody?: Buffer }, _res: unknown, buf: Buffer) => { if (req.url?.startsWith('/webhooks/')) req.rawBody = buf; } });
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.enableCors({
    origin: config.CORS_ORIGINS,
    methods: ['GET', 'POST'],
    allowedHeaders: ['authorization', 'content-type', 'x-request-id', 'x-obiba-client'],
    credentials: false,
    maxAge: 600,
  });
  app.enableShutdownHooks();
}
