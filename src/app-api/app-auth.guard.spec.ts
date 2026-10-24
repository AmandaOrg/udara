import "reflect-metadata";
import { Controller, UnauthorizedException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AppAuthGuard, isAppApiController } from "./app-auth.guard";
import { Public } from "./public.decorator";

@Controller("v1/things")
class ThingsController {
  list() {}
  @Public()
  open() {}
}

@Controller("/V1/Shouty")
class ShoutyController {
  list() {}
}

@Controller("webhooks")
class WebhookController {
  receive() {}
}

@Controller("v10/other")
class LookalikeController {
  list() {}
}

describe("AppAuthGuard", () => {
  const principal = {
    userId: "user-1",
    deviceId: "device-1",
    sessionId: "session-1",
  };
  let sessions: { authenticate: jest.Mock };
  let guard: AppAuthGuard;

  beforeEach(() => {
    sessions = { authenticate: jest.fn().mockResolvedValue(principal) };
    guard = new AppAuthGuard(new Reflector(), sessions as any);
  });

  function context(
    controller: new () => object,
    handler: string,
    headers: Record<string, unknown> = {},
  ) {
    const request: Record<string, unknown> = { headers };
    return {
      request,
      ctx: {
        getClass: () => controller,
        getHandler: () => (controller.prototype as any)[handler],
        switchToHttp: () => ({ getRequest: () => request }),
      } as any,
    };
  }

  it("leaves routes outside /v1 to their own guards", async () => {
    const { ctx } = context(WebhookController, "receive");

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(sessions.authenticate).not.toHaveBeenCalled();
  });

  it("refuses a /v1 route with no token", async () => {
    const { ctx } = context(ThingsController, "list");

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("refuses a token that is not a live session", async () => {
    sessions.authenticate.mockResolvedValue(null);
    const { ctx } = context(ThingsController, "list", {
      authorization: "Bearer udr_at_dead",
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it("refuses credentials that are not a bearer token", async () => {
    const { ctx } = context(ThingsController, "list", {
      authorization: "Basic dXNlcjpwYXNz",
    });

    await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(sessions.authenticate).not.toHaveBeenCalled();
  });

  it("attaches the principal for a live session", async () => {
    const { ctx, request } = context(ThingsController, "list", {
      authorization: "Bearer udr_at_live",
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(sessions.authenticate).toHaveBeenCalledWith("udr_at_live");
    expect(request.appPrincipal).toEqual(principal);
  });

  it("lets an explicitly public handler through without a token", async () => {
    const { ctx } = context(ThingsController, "open");

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  /**
   * Decided by the declared path, so neither casing nor a leading slash on the
   * declaration, nor a lookalike prefix, changes which controllers are guarded.
   */
  it("recognises /v1 controllers however the path is written, and nothing else", () => {
    expect(isAppApiController(ThingsController)).toBe(true);
    expect(isAppApiController(ShoutyController)).toBe(true);
    expect(isAppApiController(WebhookController)).toBe(false);
    expect(isAppApiController(LookalikeController)).toBe(false);
  });
});
