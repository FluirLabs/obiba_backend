import { Inject } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import type { App } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { appError } from '../errors';
import { CreateAccountInput } from '../graphql/types';
import { Public, RateLimit } from '../security/decorators';
import { HumanCheck } from '../security/human-check';
import { FIREBASE_APP } from '../security/identity';
import type { ObibaRequest } from '../security/request';

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CONTROL = /[\x00-\x1f\x7f]/;
const MIN_PASSWORD = 10;
const MAX_PASSWORD = 128;
const MAX_NAME = 120;
const MAX_TOKEN = 2048;

@Resolver()
export class SignUpResolver {
  constructor(
    private readonly human: HumanCheck,
    @Inject(FIREBASE_APP) private readonly firebase: App,
  ) {}

  // Client sign-up is disabled in the identity project, so this bot check cannot be skipped by calling Firebase directly.
  @Mutation(() => Boolean)
  @Public()
  @RateLimit('sign_up')
  async createAccount(@Context('req') req: ObibaRequest, @Args('input') input: CreateAccountInput): Promise<boolean> {
    const email = input.email.trim();
    const displayName = input.displayName.trim();
    if (email.length > 254 || !EMAIL.test(email)) throw appError('BAD_INPUT', 'email');
    if (input.password.length < MIN_PASSWORD || input.password.length > MAX_PASSWORD) throw appError('BAD_INPUT', 'password');
    if (!displayName || displayName.length > MAX_NAME || CONTROL.test(displayName)) throw appError('BAD_INPUT', 'displayName');
    if (!input.turnstileToken || input.turnstileToken.length > MAX_TOKEN) throw appError('HUMAN_CHECK_FAILED');
    if (!(await this.human.passes(input.turnstileToken, req.ip, 'sign_up'))) throw appError('HUMAN_CHECK_FAILED');
    try {
      await getAuth(this.firebase).createUser({ email, password: input.password, displayName });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'auth/email-already-exists') throw appError('SIGN_UP_REFUSED');
      if (code === 'auth/invalid-password') throw appError('BAD_INPUT', 'password');
      if (code === 'auth/invalid-email') throw appError('BAD_INPUT', 'email');
      throw appError('SERVICE_PAUSED');
    }
    return true;
  }
}
