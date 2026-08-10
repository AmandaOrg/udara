import { ManagerConversationService } from "./manager-conversation.service";
import { SettingsChangeStatus, SettingsChangeType } from "@prisma/client";

describe("ManagerConversationService", () => {
  let service: ManagerConversationService;
  let prisma: {
    user: { findUniqueOrThrow: jest.Mock; update: jest.Mock };
    settingsChangeRequest: {
      update: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      findMany: jest.Mock;
    };
  };
  let manager: { fileChangeRequest: jest.Mock; reviewRequest: jest.Mock };
  let whatsapp: { sendText: jest.Mock };
  let config: { get: jest.Mock };

  const user = {
    id: "user-1",
    whatsappNumber: "234801",
    statedGoal: "buy a landed property this year",
    statedGoalSetAt: new Date("2026-01-01"),
  };

  beforeEach(() => {
    prisma = {
      user: {
        findUniqueOrThrow: jest.fn().mockResolvedValue(user),
        update: jest.fn(),
      },
      settingsChangeRequest: {
        update: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findMany: jest.fn(),
      },
    };
    manager = { fileChangeRequest: jest.fn(), reviewRequest: jest.fn() };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "wamid.1" }),
    };
    config = { get: jest.fn((_key: string, fallback?: unknown) => fallback) };

    service = new ManagerConversationService(
      prisma as any,
      manager as any,
      whatsapp as any,
      config as any,
    );
  });

  describe("fileChangeRequest", () => {
    it("delegates to ManagerService, stamps initialReplyDueAt, and sends an immediate ack", async () => {
      const request = { id: "req-1", eligibleAt: new Date() };
      manager.fileChangeRequest.mockResolvedValue(request);

      await service.fileChangeRequest({
        userId: "user-1",
        type: SettingsChangeType.WINDOW_HOURS,
        requestedChange: "move to 9-6",
      });

      expect(manager.fileChangeRequest).toHaveBeenCalled();
      expect(prisma.settingsChangeRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "req-1" },
          data: expect.objectContaining({
            initialReplyDueAt: expect.any(Date),
          }),
        }),
      );
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.any(String),
        "user-1",
      );
    });

    it("stamps a due time roughly MANAGER_INITIAL_REPLY_DELAY_HOURS in the future", async () => {
      config.get.mockImplementation((key: string, fallback?: unknown) =>
        key === "MANAGER_INITIAL_REPLY_DELAY_HOURS" ? 5 : fallback,
      );
      manager.fileChangeRequest.mockResolvedValue({
        id: "req-1",
        eligibleAt: new Date(),
      });

      const before = Date.now();
      await service.fileChangeRequest({
        userId: "user-1",
        type: SettingsChangeType.OVERRIDE_FEES,
        requestedChange: "waive fees",
      });

      const call = prisma.settingsChangeRequest.update.mock.calls[0][0];
      const dueAt = call.data.initialReplyDueAt.getTime();
      expect(dueAt - before).toBeCloseTo(5 * 60 * 60 * 1000, -3);
    });
  });

  describe("sendInitialReply", () => {
    it("quotes the user's statedGoal and states eligibleAt plainly", async () => {
      const eligibleAt = new Date("2026-08-17T00:00:00Z");
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
        id: "req-1",
        userId: "user-1",
        requestedChange: "turn off the window",
        reason: "flexibility",
        eligibleAt,
      });

      await service.sendInitialReply("req-1");

      const [, message] = whatsapp.sendText.mock.calls[0];
      expect(message).toContain("buy a landed property this year");
      expect(message).toContain(eligibleAt.toDateString());
      expect(message).toContain("turn off the window");
      expect(message).toContain("flexibility");
      expect(prisma.settingsChangeRequest.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "req-1" },
          data: { initialReplySentAt: expect.any(Date) },
        }),
      );
    });

    it("still states eligibleAt plainly when the user has no statedGoal", async () => {
      prisma.user.findUniqueOrThrow.mockResolvedValue({
        ...user,
        statedGoal: null,
        statedGoalSetAt: null,
      });
      const eligibleAt = new Date("2026-08-17T00:00:00Z");
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
        id: "req-1",
        userId: "user-1",
        requestedChange: "x",
        reason: null,
        eligibleAt,
      });

      await service.sendInitialReply("req-1");

      const [, message] = whatsapp.sendText.mock.calls[0];
      expect(message).toContain(eligibleAt.toDateString());
      expect(message).not.toContain("undefined");
    });

    it("leaves initialReplySentAt unset if the WhatsApp send fails, so it stays eligible for retry", async () => {
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
        id: "req-1",
        userId: "user-1",
        requestedChange: "x",
        reason: null,
        eligibleAt: new Date(),
      });
      whatsapp.sendText.mockRejectedValue(new Error("Meta API down"));

      await expect(service.sendInitialReply("req-1")).rejects.toThrow(
        "Meta API down",
      );
      expect(prisma.settingsChangeRequest.update).not.toHaveBeenCalled();
    });
  });

  describe("reviewRequest", () => {
    it("delegates the hard gate check to ManagerService unchanged", async () => {
      manager.reviewRequest.mockRejectedValue(
        new Error("Not eligible for review until ..."),
      );
      await expect(service.reviewRequest("req-1", "APPROVED")).rejects.toThrow(
        "Not eligible for review",
      );
      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("sets disciplineExitedAt when APPROVED + EXIT_RESTRICTIONS", async () => {
      manager.reviewRequest.mockResolvedValue({
        id: "req-1",
        userId: "user-1",
        type: SettingsChangeType.EXIT_RESTRICTIONS,
        requestedChange: "exit",
        status: SettingsChangeStatus.APPROVED,
      });

      await service.reviewRequest("req-1", "APPROVED");

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "user-1" },
          data: { disciplineExitedAt: expect.any(Date) },
        }),
      );
      const [, message] = whatsapp.sendText.mock.calls[0];
      expect(message).toContain("returned to normal");
    });

    it("does NOT set disciplineExitedAt for an APPROVED request of a different type", async () => {
      manager.reviewRequest.mockResolvedValue({
        id: "req-1",
        userId: "user-1",
        type: SettingsChangeType.WINDOW_HOURS,
        requestedChange: "move window",
        status: SettingsChangeStatus.APPROVED,
      });

      await service.reviewRequest("req-1", "APPROVED");

      expect(prisma.user.update).not.toHaveBeenCalled();
    });

    it("does NOT set disciplineExitedAt for a REJECTED EXIT_RESTRICTIONS request", async () => {
      manager.reviewRequest.mockResolvedValue({
        id: "req-1",
        userId: "user-1",
        type: SettingsChangeType.EXIT_RESTRICTIONS,
        requestedChange: "exit",
        status: SettingsChangeStatus.REJECTED,
      });

      await service.reviewRequest("req-1", "REJECTED", "not convinced");

      expect(prisma.user.update).not.toHaveBeenCalled();
      const [, message] = whatsapp.sendText.mock.calls[0];
      expect(message).toContain("not approved");
      expect(message).toContain("not convinced");
    });
  });

  describe("findDueInitialReplies", () => {
    it("queries for PENDING requests past their initialReplyDueAt with no initialReplySentAt", async () => {
      prisma.settingsChangeRequest.findMany.mockResolvedValue([]);
      await service.findDueInitialReplies();
      expect(prisma.settingsChangeRequest.findMany).toHaveBeenCalledWith({
        where: {
          initialReplyDueAt: { lte: expect.any(Date) },
          initialReplySentAt: null,
          status: SettingsChangeStatus.PENDING,
        },
      });
    });
  });
});
