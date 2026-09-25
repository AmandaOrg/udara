import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PATH_METADATA } from "@nestjs/common/constants";
import { SessionService } from "../app-auth/session.service";
import { IS_PUBLIC_KEY } from "./public.decorator";
import type { AppRequest } from "./current-principal.decorator";

/**
 * Authentication for the mobile app API (S14), deny by default.
 *
 * Registered globally, it decides by the controller's *declared* route path,
 * not the request URL: every controller mounted under v1 needs a live session
 * unless a handler is explicitly @Public(). Reading the URL instead would be
 * fooled by Express matching routes case-insensitively ("/V1/me" reaches the
 * "/v1/me" handler). Webhooks and /health are not under v1 and are untouched;
 * they have their own signature guards.
 */
@Injectable()
export class AppAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly sessions: SessionService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!isAppApiController(context.getClass())) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context
      .switchToHttp()
      .getRequest<AppRequest & { headers: Record<string, unknown> }>();
    const token = bearerToken(request.headers.authorization);
    if (!token) throw new UnauthorizedException();

    const principal = await this.sessions.authenticate(token);
    if (!principal) throw new UnauthorizedException();

    request.appPrincipal = principal;
    return true;
  }
}

export function isAppApiController(controller: object): boolean {
  const path = Reflect.getMetadata(PATH_METADATA, controller);
  const normalized = String(path ?? "")
    .replace(/^\/+/, "")
    .toLowerCase();
  return normalized === "v1" || normalized.startsWith("v1/");
}

function bearerToken(header: unknown): string | null {
  if (typeof header !== "string") return null;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match ? match[1] : null;
}
