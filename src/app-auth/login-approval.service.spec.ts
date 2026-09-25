import { LoginStepUpMethod } from "@prisma/client";
import { LoginApprovalService } from "./login-approval.service";

describe("LoginApprovalService", () => {
  const now = new Date("2026-09-25T12:00:00Z");
  const user = { id: "user-1", whatsappNumber: "2348012345678" };
  let prisma: {
    loginChallenge: { updateMany: jest.Mock; findUnique: jest.Mock };
    device: { update: jest.Mock };
  };
  let messenger: { sendText: jest.Mock };
  let service: LoginApprovalService;

  beforeEach(() => {
    prisma = {
      loginChallenge: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest
          .fn()
          .mockResolvedValue({ id: "challenge-1", deviceId: "device-1" }),
      },
      device: { update: jest.fn() },
    };
    messenger = { sendText: jest.fn().mockResolvedValue(undefined) };
    service = new LoginApprovalService(prisma as any, messenger as any);
  });

  /** A button naming someone else's sign-in, or a stale one, must change nothing. */
  it("only answers an open WhatsApp request belonging to whoever tapped", async () => {
    await service.decide(user, "challenge-1", true, now);

    expect(prisma.loginChallenge.updateMany).toHaveBeenCalledWith({
      where: {
        id: "challenge-1",
        userId: "user-1",
        method: LoginStepUpMethod.WHATSAPP,
        approvedAt: null,
        rejectedAt: null,
        consumedAt: null,
        expiresAt: { gt: now },
      },
      data: { approvedAt: now },
    });
    expect(messenger.sendText).toHaveBeenCalledWith(
      user,
      expect.stringContaining("signed in"),
    );
  });

  it("revokes the device when the user says it wasn't them", async () => {
    await service.decide(user, "challenge-1", false, now);

    expect(prisma.loginChallenge.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { rejectedAt: now } }),
    );
    expect(prisma.device.update).toHaveBeenCalledWith({
      where: { id: "device-1" },
      data: { revokedAt: now },
    });
    expect(messenger.sendText).toHaveBeenCalledWith(
      user,
      expect.stringContaining("blocked"),
    );
  });

  it("says so, and changes nothing, when the request is closed or not theirs", async () => {
    prisma.loginChallenge.updateMany.mockResolvedValue({ count: 0 });

    await service.decide(user, "challenge-1", false, now);

    expect(prisma.device.update).not.toHaveBeenCalled();
    expect(messenger.sendText).toHaveBeenCalledWith(
      user,
      expect.stringContaining("expired or was already answered"),
    );
  });
});
