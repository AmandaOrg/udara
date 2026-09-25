import { SetMetadata } from "@nestjs/common";

export const IS_PUBLIC_KEY = "appApi:isPublic";

/**
 * Opts one /v1 handler out of authentication. Only for the sign-in routes
 * themselves; scripts/check-security.js (S14) fails the build if it appears
 * anywhere else.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
