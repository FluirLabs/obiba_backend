import { Inject, Injectable } from '@nestjs/common';
import { APP_CONFIG, appOrigin, type AppConfig } from '../config';
import { appError } from '../errors';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface VerifyResult {
  success?: boolean;
  hostname?: string;
  action?: string;
}

@Injectable()
export class HumanCheck {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async passes(token: string, ip: string | undefined, action: string): Promise<boolean> {
    const secret = this.config.TURNSTILE_SECRET_KEY;
    if (!secret) throw appError('SERVICE_PAUSED');
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    let result: VerifyResult;
    try {
      const res = await fetch(VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(5_000) });
      if (!res.ok) throw new Error(`siteverify ${res.status}`);
      result = (await res.json()) as VerifyResult;
    } catch {
      throw appError('SERVICE_PAUSED');
    }
    return result.success === true && result.action === action && result.hostname === new URL(appOrigin(this.config)).hostname;
  }
}
