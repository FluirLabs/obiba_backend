import {
  BadRequestException,
  Body,
  CanActivate,
  ConflictException,
  Controller,
  Delete,
  ExecutionContext,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
  Query,
  Req,
  SetMetadata,
  UseGuards,
  type DynamicModule,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AdminError, AdminService, type ReviewType } from './admin';
import { ROLES, type StaffRole } from './config';
import { IapVerifier } from './iap';
import { CONSOLE_HTML } from './console';
import { OpsService } from './ops';
import { SupportService } from './support';

const MIN_ROLE = 'obiba:min-role';
const Role = (role: StaffRole) => SetMetadata(MIN_ROLE, role);
const STAFF = Symbol('STAFF');

interface StaffRequest {
  headers: Record<string, string | string[] | undefined>;
  staff?: { email: string; role: StaffRole };
}

@Injectable()
class StaffGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly iap: IapVerifier,
    @Inject(STAFF) private readonly staff: Map<string, StaffRole>,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<StaffRequest>();
    let email: string;
    try {
      const assertion = req.headers['x-goog-iap-jwt-assertion'];
      email = await this.iap.verify(typeof assertion === 'string' ? assertion : undefined);
    } catch {
      throw new ForbiddenException();
    }
    const role = this.staff.get(email);
    const needed = this.reflector.get<StaffRole>(MIN_ROLE, ctx.getHandler()) ?? 'viewer';
    if (!role || ROLES.indexOf(role) < ROLES.indexOf(needed)) throw new ForbiddenException();
    req.staff = { email, role };
    return true;
  }
}

async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof AdminError) {
      if (err.status === 400) throw new BadRequestException(err.message);
      if (err.status === 404) throw new NotFoundException(err.message);
      throw new ConflictException(err.message);
    }
    throw err;
  }
}

const REVIEW_TYPES = new Set<ReviewType>(['deposit', 'withdrawal', 'invoice_payment', 'sandbox']);

const CONSOLE = Symbol('CONSOLE');

interface ConsoleSettings {
  devStaff: string[] | null;
}

@Controller()
class HealthController {
  constructor(@Inject(CONSOLE) private readonly console: ConsoleSettings) {}

  @Get('healthz')
  health() {
    return { status: 'ok' };
  }

  @Get('console')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('cache-control', 'no-store')
  @Header('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
  page() {
    return CONSOLE_HTML;
  }

  @Get('console/settings')
  settings() {
    return { devStaff: this.console.devStaff };
  }
}

@Controller('v1/support-cases')
@UseGuards(StaffGuard)
class SupportController {
  constructor(private readonly support: SupportService) {}

  @Get()
  @Role('operator')
  list(@Query('status') status?: string) {
    if (status !== undefined && !['open', 'SUBMITTED', 'REJECTED', 'CANCELLED'].includes(status)) throw new BadRequestException();
    return this.support.list(status);
  }

  @Get(':id')
  @Role('operator')
  get(@Param('id') id: string) {
    return run(() => this.support.get(id));
  }

  @Post(':id/verify')
  @Role('operator')
  @HttpCode(200)
  verify(@Req() req: StaffRequest, @Param('id') id: string, @Body() body: { checks?: unknown; notes?: unknown }) {
    return run(() => this.support.verify(req.staff!.email, id, body?.checks, body?.notes));
  }

  @Post(':id/approve')
  @Role('admin')
  @HttpCode(200)
  approve(@Req() req: StaffRequest, @Param('id') id: string, @Body() body: { note?: unknown }) {
    return run(() => this.support.approve(req.staff!.email, id, body?.note));
  }

  @Post(':id/reject')
  @Role('operator')
  @HttpCode(200)
  reject(@Req() req: StaffRequest, @Param('id') id: string, @Body() body: { reason?: unknown }) {
    return run(() => this.support.reject(req.staff!.email, id, body?.reason));
  }
}

@Controller('v1')
@UseGuards(StaffGuard)
class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('me')
  me(@Req() req: StaffRequest) {
    return req.staff;
  }

  @Get('overview')
  overview() {
    return this.admin.overview();
  }

  @Get('review-queue')
  reviewQueue() {
    return this.admin.reviewQueue();
  }

  @Post('review/:type/:id')
  @Role('operator')
  @HttpCode(200)
  resolve(@Req() req: StaffRequest, @Param('type') type: string, @Param('id') id: string, @Body() body: { to?: unknown; note?: unknown }) {
    if (!REVIEW_TYPES.has(type as ReviewType) || typeof body?.to !== 'string') throw new BadRequestException();
    return run(() => this.admin.resolve(req.staff!.email, type as ReviewType, id, body.to as string, body.note));
  }

  @Get('reconciliation')
  reconciliation(@Query('mismatched') mismatched?: string) {
    return this.admin.reconciliation(mismatched === 'true');
  }

  @Post('accounts/:accountId/status')
  @Role('admin')
  @HttpCode(200)
  accountStatus(@Req() req: StaffRequest, @Param('accountId') accountId: string, @Body() body: { status?: unknown; note?: unknown }) {
    return run(() => this.admin.setAccountStatus(req.staff!.email, accountId, body?.status, body?.note));
  }

  @Get('kill-switches')
  killSwitches() {
    return this.admin.killSwitches();
  }

  @Put('kill-switches/:name')
  @Role('operator')
  setKillSwitch(@Req() req: StaffRequest, @Param('name') name: string, @Body() body: { minutes?: unknown; note?: unknown }) {
    return run(() => this.admin.setKillSwitch(req.staff!.email, name, body?.minutes, body?.note));
  }

  @Delete('kill-switches/:name')
  @Role('operator')
  clearKillSwitch(@Req() req: StaffRequest, @Param('name') name: string, @Body() body: { note?: unknown }) {
    return run(() => this.admin.clearKillSwitch(req.staff!.email, name, body?.note));
  }

  @Get('pilot/requests')
  pilotRequests() {
    return this.admin.pilotRequests();
  }

  @Post('pilot/:uid')
  @Role('admin')
  @HttpCode(200)
  setPilot(@Req() req: StaffRequest, @Param('uid') uid: string, @Body() body: { allowed?: unknown }) {
    return run(() => this.admin.setPilot(req.staff!.email, uid, body?.allowed));
  }

  @Post('internal-testers/:uid')
  @Role('admin')
  @HttpCode(200)
  setInternalTester(@Req() req: StaffRequest, @Param('uid') uid: string, @Body() body: { enabled?: unknown; note?: unknown }) {
    return run(() => this.admin.setInternalTester(req.staff!.email, uid, body?.enabled, body?.note));
  }

  @Post('merchants/:uid')
  @Role('admin')
  @HttpCode(200)
  setMerchant(@Req() req: StaffRequest, @Param('uid') uid: string, @Body() body: { merchant?: unknown; note?: unknown }) {
    return run(() => this.admin.setMerchant(req.staff!.email, uid, body?.merchant, body?.note));
  }
}

@Controller('v1/ops')
@UseGuards(StaffGuard)
class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get('session')
  session(@Req() req: StaffRequest) {
    return this.ops.session(req.staff!.email, req.staff!.role);
  }

  @Get('overview')
  overview(@Query('window') window?: string) {
    return run(() => this.ops.overview(window));
  }

  @Get('transactions')
  transactions(@Req() req: StaffRequest, @Query() query: Record<string, unknown>) {
    return run(() => this.ops.transactions(query, req.staff!.role));
  }

  @Get('transactions/:type/:id')
  transaction(@Param('type') type: string, @Param('id') id: string) {
    return run(() => this.ops.transaction(type, id));
  }

  @Get('customers')
  customers(@Req() req: StaffRequest, @Query() query: Record<string, unknown>) {
    return run(() => this.ops.customers(query, req.staff!.role));
  }

  @Get('customers/:uid')
  customer(@Param('uid') uid: string) {
    return run(() => this.ops.customer(uid));
  }

  @Post('customers/:uid/reveal')
  @Role('operator')
  @HttpCode(200)
  reveal(@Req() req: StaffRequest, @Param('uid') uid: string, @Body() body: { reason?: unknown }) {
    return run(() => this.ops.reveal(req.staff!.email, uid, body?.reason));
  }

  @Get('ledger')
  ledger() {
    return run(() => this.ops.ledger());
  }

  @Get('ledger/journals')
  journals(@Query() query: Record<string, unknown>) {
    return run(() => this.ops.journals(query));
  }

  @Get('treasury')
  treasury() {
    return run(() => this.ops.treasury());
  }

  @Get('providers')
  providers() {
    return run(() => this.ops.providers());
  }

  @Get('jobs')
  jobs() {
    return run(() => this.ops.jobs());
  }

  @Get('audit')
  @Role('operator')
  audit(@Query() query: Record<string, unknown>) {
    return run(() => this.ops.auditLog(query));
  }

  @Get('staff')
  @Role('admin')
  staff() {
    return run(() => this.ops.staff());
  }

  @Get('settings')
  settings() {
    return run(() => this.ops.settingsView());
  }

  @Get('incidents')
  incidents(@Query() query: Record<string, unknown>) {
    return run(() => this.ops.incidents(query));
  }

  @Get('incidents/:id')
  incident(@Param('id') id: string) {
    return run(() => this.ops.incident(id));
  }

  @Post('incidents')
  @Role('operator')
  @HttpCode(201)
  declare(@Req() req: StaffRequest, @Body() body: Record<string, unknown>) {
    return run(() => this.ops.declareIncident(req.staff!.email, body ?? {}));
  }

  @Post('incidents/:id/:action')
  @Role('operator')
  @HttpCode(200)
  transition(@Req() req: StaffRequest, @Param('id') id: string, @Param('action') action: string, @Body() body: Record<string, unknown>) {
    if (!['acknowledge', 'investigate', 'note', 'resolve'].includes(action)) throw new NotFoundException();
    return run(() => this.ops.transitionIncident(req.staff!.email, id, action as 'acknowledge' | 'investigate' | 'note' | 'resolve', body ?? {}));
  }

  @Post('reports/:kind')
  @Role('operator')
  @HttpCode(200)
  report(@Req() req: StaffRequest, @Param('kind') kind: string, @Body() body: { from?: unknown; to?: unknown; purpose?: unknown }) {
    return run(() => this.ops.report(req.staff!.email, kind, body));
  }
}

@Module({})
export class AdminModule {
  static create(admin: AdminService, iap: IapVerifier, staff: Map<string, StaffRole>, support: SupportService, console: ConsoleSettings = { devStaff: null }, ops?: OpsService): DynamicModule {
    return {
      module: AdminModule,
      controllers: ops ? [HealthController, AdminController, SupportController, OpsController] : [HealthController, AdminController, SupportController],
      providers: [
        { provide: AdminService, useValue: admin },
        { provide: SupportService, useValue: support },
        ...(ops ? [{ provide: OpsService, useValue: ops }] : []),
        { provide: IapVerifier, useValue: iap },
        { provide: STAFF, useValue: staff },
        { provide: CONSOLE, useValue: console },
        StaffGuard,
      ],
    };
  }
}
