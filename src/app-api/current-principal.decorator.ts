import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from "@nestjs/common";
import type { AppPrincipal } from "../app-auth/session.service";

export type AppRequest = { appPrincipal?: AppPrincipal };

/** The signed-in user and device, as AppAuthGuard resolved them. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AppPrincipal => {
    const principal = context
      .switchToHttp()
      .getRequest<AppRequest>().appPrincipal;
    if (!principal) {
      // Only reachable on a @Public() handler that asked for a principal: a
      // programming error, never something a client can cause.
      throw new InternalServerErrorException();
    }
    return principal;
  },
);
