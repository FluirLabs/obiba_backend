import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { BadRequestException, Controller, Headers, HttpCode, Inject, NotFoundException, Post, Req, UnauthorizedException } from '@nestjs/common';
import type { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config';
import { PG_POOL } from '../infra/tokens';
import { Public } from '../security/decorators';
import type { ObibaRequest } from '../security/request';

const TOLERANCE_SECONDS = 300;

export function verifyWebhookSignature(secret: string, id: string, timestamp: string, body: Buffer, signatures: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const sent = Number(timestamp);
  if (!id || !Number.isFinite(sent) || Math.abs(nowSeconds - sent) > TOLERANCE_SECONDS) return false;
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${id}.${timestamp}.`).update(body).digest();
  return signatures.split(' ').some((entry) => {
    const [version, value] = entry.split(',');
    if (version !== 'v1' || !value) return false;
    const given = Buffer.from(value, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}

function statusOf(event: { type?: string; data?: { bounce?: { type?: string } } }): string | null {
  if (event.type === 'email.delivered') return 'delivered';
  if (event.type === 'email.delivery_delayed') return 'delayed';
  if (event.type === 'email.complained') return 'complained';
  if (event.type === 'email.bounced') return event.data?.bounce?.type === 'Transient' ? 'delayed' : 'bounced';
  return null;
}

@Controller('webhooks')
export class EmailWebhookController {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: Pool,
  ) {}

  @Post('resend')
  @Public()
  @HttpCode(200)
  async resend(@Req() req: ObibaRequest & { rawBody?: Buffer }, @Headers('svix-id') id: string, @Headers('svix-timestamp') timestamp: string, @Headers('svix-signature') signature: string): Promise<{ ok: true }> {
    const secret = this.config.RESEND_WEBHOOK_SECRET;
    if (!secret) throw new NotFoundException();
    if (!req.rawBody || !signature) throw new BadRequestException();
    if (!verifyWebhookSignature(secret, id, timestamp, req.rawBody, signature)) throw new UnauthorizedException();
    const event = JSON.parse(req.rawBody.toString('utf8')) as { type?: string; data?: { email_id?: unknown; to?: unknown; bounce?: { type?: string } } };
    const status = statusOf(event);
    const providerId = event.data?.email_id;
    if (status && typeof providerId === 'string') {
      const to = Array.isArray(event.data?.to) && typeof event.data.to[0] === 'string' ? createHash('sha256').update(event.data.to[0].trim().toLowerCase()).digest('hex') : '';
      await this.pool.query('select ops.record_email_event($1, $2, $3)', [providerId, status, to]);
    }
    return { ok: true };
  }
}
