import { SetMetadata } from '@nestjs/common';

export const PUBLIC = 'obiba:public';
export const WITHOUT_PROFILE = 'obiba:without-profile';
export const STEP_UP = 'obiba:step-up';
export const RATE_LIMIT = 'obiba:rate-limit';
export const MERCHANT = 'obiba:merchant';
export const FRESH_SESSION = 'obiba:fresh-session';
export const SKIP_RATE_LIMIT = 'obiba:skip-rate-limit';
export const ALLOW_UNVERIFIED = 'obiba:allow-unverified';

export const Public = () => SetMetadata(PUBLIC, true);
export const AllowWithoutProfile = () => SetMetadata(WITHOUT_PROFILE, true);
export const RequireStepUp = () => SetMetadata(STEP_UP, true);
export const RequireMerchant = () => SetMetadata(MERCHANT, true);
export const RequireFreshSession = () => SetMetadata(FRESH_SESSION, true);
export const RateLimit = (...rules: string[]) => SetMetadata(RATE_LIMIT, rules);
export const SkipRateLimit = () => SetMetadata(SKIP_RATE_LIMIT, true);
export const AllowUnverified = () => SetMetadata(ALLOW_UNVERIFIED, true);
