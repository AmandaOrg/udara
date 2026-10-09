import { ConflictException } from "@nestjs/common";
import {
  TERMS_SUMMARY,
  TERMS_VERSION,
  needsTermsConsent,
} from "../../onboarding/terms.data";
import { TermsController } from "./terms.controller";

describe("needsTermsConsent", () => {
  const at = new Date("2026-09-01T00:00:00Z");

  it("asks only someone who agreed to an earlier version", () => {
    expect(
      needsTermsConsent({ termsAcceptedAt: at, termsVersion: "2025-01-v0" }),
    ).toBe(true);
    expect(
      needsTermsConsent({ termsAcceptedAt: at, termsVersion: TERMS_VERSION }),
    ).toBe(false);
    // Still onboarding: they agree in the conversation, not here.
    expect(
      needsTermsConsent({ termsAcceptedAt: null, termsVersion: null }),
    ).toBe(false);
  });
});

describe("TermsController", () => {
  const principal = { userId: "user-1", deviceId: "device-1", sessionId: "s1" };
  const at = new Date("2026-09-01T00:00:00Z");
  let prisma: any;
  let controller: TermsController;

  beforeEach(() => {
    prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: "user-1",
          termsAcceptedAt: at,
          termsVersion: "2025-01-v0",
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    controller = new TermsController(prisma);
  });

  it("shows the current terms and what the caller last agreed to", async () => {
    await expect(controller.get(principal)).resolves.toEqual({
      version: TERMS_VERSION,
      summary: TERMS_SUMMARY,
      consentQuestion: expect.any(String),
      accepted: { version: "2025-01-v0", at: at.toISOString() },
      needsConsent: true,
    });
  });

  it("records acceptance of the version the app showed, for someone who consented before", async () => {
    const view = await controller.accept(principal, { version: TERMS_VERSION });

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1", termsAcceptedAt: { not: null } },
      data: { termsAcceptedAt: expect.any(Date), termsVersion: TERMS_VERSION },
    });
    expect(view.version).toBe(TERMS_VERSION);
  });

  it("refuses an acceptance of terms the app did not show", async () => {
    const err = await controller
      .accept(principal, { version: "2025-01-v0" })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({
      error: "terms_changed",
      version: TERMS_VERSION,
    });
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("leaves first consent to the onboarding conversation", async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 });

    const err = await controller
      .accept(principal, { version: TERMS_VERSION })
      .catch((e) => e);

    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toEqual({ error: "not_onboarded" });
  });
});
