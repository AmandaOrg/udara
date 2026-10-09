import {
  BadRequestException,
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SettingsChangeStatus, SettingsChangeType } from "@prisma/client";
import { currentChannelContext } from "../../messaging/channel-context";
import { closureNotice } from "../../account-closure/closure-copy";
import { AccountDeletionController } from "./account-deletion.controller";
import { RequestAccountDeletionDto } from "./account-deletion.dto";

describe("AccountDeletionController", () => {
  const principal = { userId: "user-1", deviceId: "device-1", sessionId: "s1" };
  const at = new Date("2026-10-09T10:00:00Z");
  const request = {
    id: "req-1",
    userId: "user-1",
    type: SettingsChangeType.ACCOUNT_DELETION,
    status: SettingsChangeStatus.PENDING,
    requestedChange: "close my account",
    reason: null,
    requestedAt: at,
    eligibleAt: new Date(at.getTime() + 7 * 86_400_000),
    resolvedAt: null,
    managerNotes: null,
  };
  const withPin = { id: "user-1", pinHash: "scrypt$..." };
  let closure: { status: jest.Mock; request: jest.Mock };
  let pin: { verifyPin: jest.Mock };
  let controller: AccountDeletionController;

  /** closure.request as the service runs it: blockers first, then authorize, then file. */
  function filesAfterAuthorizing(user: Record<string, unknown>) {
    closure.request.mockImplementation(async (_id: string, params: any) => {
      await params.authorize(user);
      return {
        kind: "filed",
        request,
        completeBy: new Date(at.getTime() + 30 * 86_400_000),
      };
    });
  }

  beforeEach(() => {
    closure = { status: jest.fn(), request: jest.fn() };
    pin = { verifyPin: jest.fn().mockResolvedValue({ ok: true }) };
    controller = new AccountDeletionController(closure as any, pin as any);
  });

  it("shows what is in the way, the open request, and what closing means", async () => {
    closure.status.mockResolvedValue({
      openRequest: request,
      blockers: ["request_open"],
      balance: 0,
      hasAccount: true,
      pinSet: true,
    });

    const view = await controller.status(principal);

    expect(closure.status).toHaveBeenCalledWith("user-1");
    expect(view).toEqual({
      request: expect.objectContaining({
        id: "req-1",
        type: "account_deletion",
      }),
      completeBy: new Date(at.getTime() + 30 * 86_400_000).toISOString(),
      canRequest: false,
      blockers: ["request_open"],
      balance: 0,
      pinRequired: true,
      hasAccount: true,
      notice: closureNotice(true),
    });
  });

  it("files with the PIN checked, inside the app's channel context", async () => {
    let channel: string | undefined;
    closure.request.mockImplementation(async (_id: string, params: any) => {
      channel = currentChannelContext()?.channel;
      await params.authorize(withPin);
      return {
        kind: "filed",
        request,
        completeBy: new Date(at.getTime() + 30 * 86_400_000),
      };
    });

    const view = await controller.request(principal, {
      pin: "8317",
      reason: " moving ",
    });

    expect(closure.request).toHaveBeenCalledWith("user-1", {
      via: "app",
      reason: "moving",
      authorize: expect.any(Function),
    });
    expect(pin.verifyPin).toHaveBeenCalledWith("user-1", "8317");
    expect(channel).toBe("app");
    expect(view.request.id).toBe("req-1");
  });

  it("asks for no PIN when none is set", async () => {
    filesAfterAuthorizing({ id: "user-1", pinHash: null });

    await controller.request(principal, {});

    expect(pin.verifyPin).not.toHaveBeenCalled();
  });

  it("needs the PIN when one is set, and turns a wrong or locked one away", async () => {
    filesAfterAuthorizing(withPin);
    await expect(controller.request(principal, {})).rejects.toThrow(
      BadRequestException,
    );

    pin.verifyPin.mockResolvedValueOnce({
      ok: false,
      reason: "that pin isn't right. 2 tries left before it locks.",
    });
    await expect(
      controller.request(principal, { pin: "0000" }),
    ).rejects.toThrow(UnprocessableEntityException);

    const lockedUntil = new Date(at.getTime() + 3_600_000);
    pin.verifyPin.mockResolvedValueOnce({
      ok: false,
      reason: "locked",
      lockedUntil,
    });
    const locked = await controller
      .request(principal, { pin: "0000" })
      .catch((err: HttpException) => err);
    expect(locked).toBeInstanceOf(HttpException);
    expect((locked as HttpException).getStatus()).toBe(423);
    expect((locked as HttpException).getResponse()).toEqual({
      error: "pin_locked",
      lockedUntil: lockedUntil.toISOString(),
    });
  });

  it.each([
    ["request_open", ConflictException],
    ["payment_in_progress", ConflictException],
    ["balance_not_zero", ConflictException],
    ["balance_unavailable", ServiceUnavailableException],
  ])("answers %s without filing", async (blocker, kind) => {
    closure.request.mockResolvedValue({
      kind: "blocked",
      blocker,
      balance: blocker === "balance_not_zero" ? 1500 : null,
      openRequest: blocker === "request_open" ? request : null,
    });

    const err = await controller
      .request(principal, { pin: "8317" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(kind);
    expect(err.getResponse()).toMatchObject({ error: blocker });
    if (blocker === "balance_not_zero") {
      expect(err.getResponse()).toMatchObject({ balance: 1500 });
    }
    expect(pin.verifyPin).not.toHaveBeenCalled();
  });

  it.each([
    [{}, true],
    [{ pin: "8317", reason: "moving abroad" }, true],
    [{ pin: "831" }, false],
    [{ pin: "83a7" }, false],
    [{ reason: "x".repeat(501) }, false],
  ])("validates the body: %j", async (body, ok) => {
    const errors = await validate(
      plainToInstance(RequestAccountDeletionDto, body),
    );
    expect(errors.length === 0).toBe(ok);
  });
});
