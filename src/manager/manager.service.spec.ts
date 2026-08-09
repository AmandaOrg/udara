import { BadRequestException } from "@nestjs/common";
import { ManagerService } from "./manager.service";
import { SettingsChangeStatus, SettingsChangeType } from "@prisma/client";

/**
 * The eligibleAt gate is a hard timestamp comparison — PRD §7: "this minimum
 * holds regardless of how the request is framed." These tests exist to lock
 * that gate down, since it's the whole point of the Manager escalation mechanic.
 */
describe("ManagerService", () => {
  let service: ManagerService;
  let prisma: {
    settingsChangeRequest: {
      create: jest.Mock;
      findUniqueOrThrow: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      settingsChangeRequest: {
        create: jest.fn((args) =>
          Promise.resolve({ id: "req-1", ...args.data }),
        ),
        findUniqueOrThrow: jest.fn(),
        update: jest.fn((args) =>
          Promise.resolve({ id: args.where.id, ...args.data }),
        ),
      },
    };
    service = new ManagerService(prisma as any);
  });

  describe("fileChangeRequest", () => {
    it("sets eligibleAt exactly SETTINGS_CHANGE_MIN_DAYS (default 7) days after requestedAt", async () => {
      const before = Date.now();
      const request = await service.fileChangeRequest({
        userId: "user-1",
        type: SettingsChangeType.WINDOW_HOURS,
        requestedChange: "move window to 9am-6pm",
      });
      const after = Date.now();

      const requestedAt = new Date(request.requestedAt).getTime();
      const eligibleAt = new Date(request.eligibleAt).getTime();
      expect(requestedAt).toBeGreaterThanOrEqual(before);
      expect(requestedAt).toBeLessThanOrEqual(after);

      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      expect(eligibleAt - requestedAt).toBeCloseTo(sevenDaysMs, -3); // within ~seconds
      expect(request.status).toBe(SettingsChangeStatus.PENDING);
    });
  });

  describe("reviewRequest", () => {
    it("rejects review before eligibleAt, regardless of decision", async () => {
      const eligibleAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 1 day from now
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
        id: "req-1",
        eligibleAt,
        status: SettingsChangeStatus.PENDING,
      });

      await expect(service.reviewRequest("req-1", "APPROVED")).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.settingsChangeRequest.update).not.toHaveBeenCalled();
    });

    it("allows review once eligibleAt has passed", async () => {
      const eligibleAt = new Date(Date.now() - 1000); // 1 second in the past
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
        id: "req-1",
        eligibleAt,
        status: SettingsChangeStatus.PENDING,
      });

      const result = await service.reviewRequest(
        "req-1",
        "APPROVED",
        "looks fine",
      );

      expect(result.status).toBe("APPROVED");
      expect(result.managerNotes).toBe("looks fine");
      expect(prisma.settingsChangeRequest.update).toHaveBeenCalled();
    });

    it("allows rejection once eligibleAt has passed, same as approval", async () => {
      const eligibleAt = new Date(Date.now() - 1000);
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
        id: "req-1",
        eligibleAt,
        status: SettingsChangeStatus.PENDING,
      });

      const result = await service.reviewRequest("req-1", "REJECTED");

      expect(result.status).toBe("REJECTED");
    });

    it('is still blocked a moment before eligibleAt (not just "days" granularity)', async () => {
      // Comfortably in the future relative to test execution time, but far short of a
      // full day, to confirm the gate is a real timestamp comparison, not a date-only check.
      const eligibleAt = new Date(Date.now() + 60_000); // 1 minute in the future
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
        id: "req-1",
        eligibleAt,
        status: SettingsChangeStatus.PENDING,
      });

      await expect(service.reviewRequest("req-1", "APPROVED")).rejects.toThrow(
        BadRequestException,
      );
    });
  });
});
