import { GraphQLError } from 'graphql';

export type ErrorCode =
  | 'UNAUTHENTICATED'
  | 'EMAIL_NOT_VERIFIED'
  | 'ACCOUNT_DISABLED'
  | 'PROFILE_REQUIRED'
  | 'FORBIDDEN'
  | 'STEP_UP_REQUIRED'
  | 'RATE_LIMITED'
  | 'SERVICE_PAUSED'
  | 'BAD_INPUT'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_FUNDS'
  | 'SIGNED_OP_MISMATCH'
  | 'RECIPIENT_NOT_REGISTERED'
  | 'RECOVERY_SETUP_REQUIRED'
  | 'EXPIRED'
  | 'VIEW_ONLY'
  | 'HUMAN_CHECK_FAILED'
  | 'SIGN_UP_REFUSED'
  | 'PASSKEY_REJECTED';

const MESSAGES: Record<ErrorCode, string> = {
  UNAUTHENTICATED: 'Sign in to continue.',
  EMAIL_NOT_VERIFIED: 'Verify your email address to continue.',
  ACCOUNT_DISABLED: 'This account is not available.',
  PROFILE_REQUIRED: 'Complete your profile to continue.',
  FORBIDDEN: 'You are not allowed to do that.',
  STEP_UP_REQUIRED: 'Confirm with your authenticator code to continue.',
  RATE_LIMITED: 'Too many requests. Try again shortly.',
  SERVICE_PAUSED: 'This service is temporarily unavailable.',
  BAD_INPUT: 'Some details are not valid.',
  NOT_FOUND: 'Not found.',
  CONFLICT: 'This request conflicts with an earlier one.',
  INSUFFICIENT_FUNDS: 'Your available balance is too low.',
  SIGNED_OP_MISMATCH: 'The signed request does not match the prepared payment.',
  RECIPIENT_NOT_REGISTERED: 'This address cannot receive USDC yet.',
  RECOVERY_SETUP_REQUIRED: 'Add a passkey or save your Recovery Kit before adding money.',
  EXPIRED: 'This request has expired. Start again.',
  VIEW_ONLY: 'This session is view-only. Sign in on your own device to make changes.',
  HUMAN_CHECK_FAILED: 'We could not confirm this request is from a person.',
  SIGN_UP_REFUSED: 'We could not create an account with these details.',
  PASSKEY_REJECTED: 'We could not confirm your passkey. Try again.',
};

export function appError(code: ErrorCode, field?: string): GraphQLError {
  return new GraphQLError(MESSAGES[code], { extensions: field ? { code, field } : { code } });
}

export function isAppError(err: unknown): err is GraphQLError {
  return err instanceof GraphQLError && typeof err.extensions?.code === 'string' && err.extensions.code in MESSAGES;
}
