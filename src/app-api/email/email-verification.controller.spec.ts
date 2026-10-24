import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
  UnprocessableEntityException,
} from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { EmailVerificationController } from "./email-verification.controller";
import { ConfirmEmailCodeDto } from "./email-verification.dto";

describe("EmailVerificationController", () => {
  const principal = { userId: "user-1", deviceId: "device-1", sessionId: "s1" };
  const at = new Date("2026-10-09T10:00:00Z");
  let verification: { start: jest.Mock; confirm: jest.Mock };
  let controller: EmailVerificationController;

  beforeEach(() => {
    verification = { start: jest.fn(), confirm: jest.fn() };
    controller = new EmailVerificationController(verification as any);
  });

  it("starts a check for the caller's own address and shows it masked", async () => {
    verification.start.mockResolvedValue({
      ok: true,
      sentTo: "ad*@example.com",
      expiresAt: at,
      resendAfter: at,
    });

    await expect(controller.start(principal)).resolves.toEqual({
      sentTo: "ad*@example.com",
      expiresAt: at.toISOString(),
      resendAfter: at.toISOString(),
    });
    expect(verification.start).toHaveBeenCalledWith("user-1");
  });

  it.each([
    [{ ok: false, reason: "no_email" }, ConflictException, 409],
    [{ ok: false, reason: "already_verified" }, ConflictException, 409],
    [{ ok: false, reason: "too_soon", retryAfter: at }, HttpException, 429],
    [{ ok: false, reason: "too_many_codes" }, HttpException, 429],
    [
      { ok: false, reason: "email_unavailable" },
      ServiceUnavailableException,
      503,
    ],
  ])("answers %j", async (result, kind, status) => {
    verification.start.mockResolvedValue(result);

    const err = await controller.start(principal).catch((e) => e);

    expect(err).toBeInstanceOf(kind);
    expect(err.getStatus()).toBe(status);
    expect(err.getResponse()).toMatchObject({ error: result.reason });
  });

  it("confirms with the code, and says how many tries are left when wrong", async () => {
    verification.confirm.mockResolvedValueOnce({ ok: true });
    await expect(
      controller.confirm(principal, { code: "482913" }),
    ).resolves.toEqual({
      verified: true,
    });
    expect(verification.confirm).toHaveBeenCalledWith("user-1", "482913");

    verification.confirm.mockResolvedValueOnce({
      ok: false,
      reason: "invalid_code",
      attemptsLeft: 3,
    });
    const err = await controller
      .confirm(principal, { code: "000000" })
      .catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect(err.getResponse()).toEqual({
      error: "invalid_code",
      attemptsLeft: 3,
    });
  });

  it.each([
    ["482913", true],
    ["48291", false],
    ["48291a", false],
    ["4829133", false],
  ])("accepts only six digits: %s", async (code, ok) => {
    const errors = await validate(
      plainToInstance(ConfirmEmailCodeDto, { code }),
    );
    expect(errors.length === 0).toBe(ok);
  });
});
