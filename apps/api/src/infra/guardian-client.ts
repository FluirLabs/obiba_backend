import { Inject, Injectable } from '@nestjs/common';
import { GoogleAuth } from 'google-auth-library';
import { APP_CONFIG, type AppConfig } from '../config';

export type CosignResponse = { ok: true; signature: string } | { ok: false; reason: string };

export type RecoveryResponse = { ok: true; signature: string; guardianNonce: string } | { ok: false; reason: string };

export abstract class GuardianClient {
  abstract cosign(opId: string, deviceSignature: string, idToken: string): Promise<CosignResponse>;
  abstract recovery(recoveryId: string, idToken: string, kitSignature: string | null): Promise<RecoveryResponse>;
  abstract raiseLimit(callId: string, idToken: string): Promise<RecoveryResponse>;
  abstract deviceChange(callId: string, idToken: string): Promise<RecoveryResponse>;
}

@Injectable()
export class HttpGuardianClient extends GuardianClient {
  private readonly auth = new GoogleAuth();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
  }

  private async client(): Promise<{ request<T>(opts: { url: string; method: 'POST'; data: unknown; timeout: number }): Promise<{ data: T }> }> {
    const token = this.config.GUARDIAN_DEV_TOKEN;
    if (token) {
      return {
        async request<T>(opts: { url: string; method: 'POST'; data: unknown; timeout: number }) {
          const res = await fetch(opts.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(opts.data), signal: AbortSignal.timeout(opts.timeout), redirect: 'error' });
          if (!res.ok) throw new Error(`guardian responded ${res.status}`);
          return { data: (await res.json()) as T };
        },
      };
    }
    return this.auth.getIdTokenClient(this.config.GUARDIAN_AUDIENCE!);
  }

  async cosign(opId: string, deviceSignature: string, idToken: string): Promise<CosignResponse> {
    if (!this.config.GUARDIAN_URL || !this.config.GUARDIAN_AUDIENCE) throw new Error('guardian not configured');
    const client = await this.client();
    const res = await client.request<CosignResponse>({
      url: `${this.config.GUARDIAN_URL}/v1/cosign`,
      method: 'POST',
      data: { op_id: opId, device_signature: deviceSignature, id_token: idToken },
      timeout: 10_000,
    });
    return res.data;
  }

  async recovery(recoveryId: string, idToken: string, kitSignature: string | null): Promise<RecoveryResponse> {
    if (!this.config.GUARDIAN_URL || !this.config.GUARDIAN_AUDIENCE) throw new Error('guardian not configured');
    const client = await this.client();
    const res = await client.request<RecoveryResponse>({
      url: `${this.config.GUARDIAN_URL}/v1/recovery`,
      method: 'POST',
      data: { recovery_id: recoveryId, id_token: idToken, kit_signature: kitSignature },
      timeout: 10_000,
    });
    return res.data;
  }

  async raiseLimit(callId: string, idToken: string): Promise<RecoveryResponse> {
    if (!this.config.GUARDIAN_URL || !this.config.GUARDIAN_AUDIENCE) throw new Error('guardian not configured');
    const client = await this.client();
    const res = await client.request<RecoveryResponse>({
      url: `${this.config.GUARDIAN_URL}/v1/limit`,
      method: 'POST',
      data: { call_id: callId, id_token: idToken },
      timeout: 10_000,
    });
    return res.data;
  }

  async deviceChange(callId: string, idToken: string): Promise<RecoveryResponse> {
    if (!this.config.GUARDIAN_URL || !this.config.GUARDIAN_AUDIENCE) throw new Error('guardian not configured');
    const client = await this.client();
    const res = await client.request<RecoveryResponse>({
      url: `${this.config.GUARDIAN_URL}/v1/device-change`,
      method: 'POST',
      data: { call_id: callId, id_token: idToken },
      timeout: 10_000,
    });
    return res.data;
  }
}
