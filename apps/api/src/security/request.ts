import type { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@nestjs/graphql';
import type { Request } from 'express';
import type { VerifiedIdentity } from './identity';

export interface Profile {
  uid: string;
  status: string;
  pilot_allowed: boolean;
  merchant: boolean;
}

export interface ObibaRequest extends Request {
  identity?: VerifiedIdentity;
  profile?: Profile;
  requestId?: string;
  viewOnly?: boolean;
}

export const VIEW_ONLY_TTL_SECONDS = 24 * 3600;

export function viewOnlyKey(uid: string, authTime: number): string {
  return `viewonly:${uid}:${authTime}`;
}

export function graphqlOperation(ctx: ExecutionContext): { type: string; field: string } | null {
  if (ctx.getType<string>() !== 'graphql') return null;
  const info = GqlExecutionContext.create(ctx).getInfo<{ operation: { operation: string }; fieldName: string }>();
  return { type: info.operation.operation, field: info.fieldName };
}

export function requestOf(ctx: ExecutionContext): ObibaRequest {
  if (ctx.getType<string>() === 'graphql') {
    return GqlExecutionContext.create(ctx).getContext<{ req: ObibaRequest }>().req;
  }
  return ctx.switchToHttp().getRequest<ObibaRequest>();
}

export function identityOf(req: ObibaRequest): VerifiedIdentity {
  if (!req.identity) throw new Error('identity missing after AuthGuard');
  return req.identity;
}
