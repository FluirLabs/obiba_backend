import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Inject, Module, Post, type DynamicModule } from '@nestjs/common';
import { Guardian } from './guardian';
import { CALLER_VERIFIER, SUPPORT_CALLERS } from './tokens';
import type { CallerVerifier } from './verifiers';

interface CosignBody {
  op_id?: unknown;
  device_signature?: unknown;
  id_token?: unknown;
}

async function verifyApiCaller(callers: CallerVerifier, supportCallers: Set<string>, auth: string | undefined): Promise<void> {
  let caller: string;
  try {
    caller = await callers.verify(auth);
  } catch {
    throw new ForbiddenException();
  }
  if (supportCallers.has(caller)) throw new ForbiddenException();
}

@Controller()
class GuardianController {
  constructor(
    private readonly guardian: Guardian,
    @Inject(CALLER_VERIFIER) private readonly callers: CallerVerifier,
    @Inject(SUPPORT_CALLERS) private readonly supportCallers: Set<string>,
  ) {}

  private apiCaller(auth: string | undefined): Promise<void> {
    return verifyApiCaller(this.callers, this.supportCallers, auth);
  }

  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  @Post('v1/cosign')
  @HttpCode(200)
  async cosign(@Headers('authorization') auth: string | undefined, @Body() body: CosignBody) {
    await this.apiCaller(auth);
    const { op_id, device_signature, id_token } = body ?? {};
    if (typeof op_id !== 'string' || typeof device_signature !== 'string' || typeof id_token !== 'string') return { ok: false, reason: 'bad_request' };
    if (device_signature.length > 200 || id_token.length > 4096) return { ok: false, reason: 'bad_request' };
    return this.guardian.cosign(op_id, device_signature, id_token);
  }
}

interface RecoveryBody {
  recovery_id?: unknown;
  id_token?: unknown;
  kit_signature?: unknown;
}

@Controller()
class RecoveryController {
  constructor(
    private readonly guardian: Guardian,
    @Inject(CALLER_VERIFIER) private readonly callers: CallerVerifier,
    @Inject(SUPPORT_CALLERS) private readonly supportCallers: Set<string>,
  ) {}

  private apiCaller(auth: string | undefined): Promise<void> {
    return verifyApiCaller(this.callers, this.supportCallers, auth);
  }

  @Post('v1/recovery')
  @HttpCode(200)
  async recovery(@Headers('authorization') auth: string | undefined, @Body() body: RecoveryBody) {
    await this.apiCaller(auth);
    const { recovery_id, id_token, kit_signature } = body ?? {};
    if (typeof recovery_id !== 'string' || typeof id_token !== 'string' || id_token.length > 4096) return { ok: false, reason: 'bad_request' };
    if (kit_signature !== undefined && kit_signature !== null && (typeof kit_signature !== 'string' || kit_signature.length > 100)) return { ok: false, reason: 'bad_request' };
    return this.guardian.recovery(recovery_id, id_token, typeof kit_signature === 'string' ? kit_signature : null);
  }

  @Post('v1/support-recovery')
  @HttpCode(200)
  async supportRecovery(@Headers('authorization') auth: string | undefined, @Body() body: { recovery_id?: unknown }) {
    let caller: string;
    try {
      caller = await this.callers.verify(auth);
    } catch {
      throw new ForbiddenException();
    }
    if (!this.supportCallers.has(caller)) throw new ForbiddenException();
    const { recovery_id } = body ?? {};
    if (typeof recovery_id !== 'string') return { ok: false, reason: 'bad_request' };
    return this.guardian.supportRecovery(recovery_id);
  }

  @Post('v1/limit')
  @HttpCode(200)
  async limit(@Headers('authorization') auth: string | undefined, @Body() body: { call_id?: unknown; id_token?: unknown }) {
    await this.apiCaller(auth);
    const { call_id, id_token } = body ?? {};
    if (typeof call_id !== 'string' || typeof id_token !== 'string' || id_token.length > 4096) return { ok: false, reason: 'bad_request' };
    return this.guardian.raiseLimit(call_id, id_token);
  }

  @Post('v1/device-change')
  @HttpCode(200)
  async deviceChange(@Headers('authorization') auth: string | undefined, @Body() body: { call_id?: unknown; id_token?: unknown }) {
    await this.apiCaller(auth);
    const { call_id, id_token } = body ?? {};
    if (typeof call_id !== 'string' || typeof id_token !== 'string' || id_token.length > 4096) return { ok: false, reason: 'bad_request' };
    return this.guardian.deviceChange(call_id, id_token);
  }
}

@Module({})
export class GuardianModule {
  static create(guardian: Guardian, callers: CallerVerifier, supportCallers: Set<string> = new Set()): DynamicModule {
    return {
      module: GuardianModule,
      controllers: [GuardianController, RecoveryController],
      providers: [
        { provide: Guardian, useValue: guardian },
        { provide: CALLER_VERIFIER, useValue: callers },
        { provide: SUPPORT_CALLERS, useValue: supportCallers },
      ],
    };
  }
}
