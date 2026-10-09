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
      findFirst: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
  };

  beforeEach(() => {
    prisma = {
      settingsChangeRequest: {
        create: jest.fn((args) =>
          Promise.resolve({ id: "req-1", ...args.data }),
        ),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        update: jest.fn((args) =>
          Promise.resolve({ id: args.where.id, ...args.data }),
        ),
        // The decision is claimed from an undecided status; count 1 means this
        // caller made it. See the "decisions are final" test below.
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
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

      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: "req-1",
        eligibleAt,
        status: SettingsChangeStatus.PENDING,
      });
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: "req-1",
        status: SettingsChangeStatus.APPROVED,
        managerNotes: "looks fine",
      });

      const result = await service.reviewRequest(
        "req-1",
        "APPROVED",
        "looks fine",
      );

      expect(result.status).toBe("APPROVED");
      expect(result.managerNotes).toBe("looks fine");
      expect(prisma.settingsChangeRequest.updateMany).toHaveBeenCalled();
    });

    /**
     * This decision can lift a user's spending restrictions entirely, so it
     * must not be re-openable. A plain update let a REJECTED request be flipped
     * to APPROVED later, and let a second review overwrite the first.
     */
    it("refuses to re-decide a request that already has an outcome", async () => {
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
        id: "req-1",
        eligibleAt: new Date(Date.now() - 1000),
        status: SettingsChangeStatus.REJECTED,
      });
      prisma.settingsChangeRequest.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.reviewRequest("req-1", "APPROVED")).rejects.toThrow(
        BadRequestException,
      );
    });

    it("allows rejection once eligibleAt has passed, same as approval", async () => {
      const eligibleAt = new Date(Date.now() - 1000);
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
        id: "req-1",
        eligibleAt,
        status: SettingsChangeStatus.PENDING,
      });

      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: "req-1",
        eligibleAt,
        status: SettingsChangeStatus.PENDING,
      });
      prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValueOnce({
        id: "req-1",
        status: SettingsChangeStatus.REJECTED,
      });

      const result = await service.reviewRequest("req-1", "REJECTED");

      expect(result.status).toBe("REJECTED");
    });

    /**
     * Approving a closure request here would mark it done while nothing was
     * closed. Only AccountClosureService decides those (ADR-0003).
     */
    it.each(["APPROVED", "REJECTED"] as const)(
      "refuses to decide an account closure request (%s), even once eligible",
      async (decision) => {
        prisma.settingsChangeRequest.findUniqueOrThrow.mockResolvedValue({
          id: "req-1",
          type: SettingsChangeType.ACCOUNT_DELETION,
          eligibleAt: new Date(Date.now() - 1000),
          status: SettingsChangeStatus.PENDING,
        });

        await expect(service.reviewRequest("req-1", decision)).rejects.toThrow(
          /account:close/,
        );
        expect(prisma.settingsChangeRequest.updateMany).not.toHaveBeenCalled();
      },
    );

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

  describe("withdrawRequest", () => {
    const now = new Date("2026-10-09T10:00:00Z");

    it("claims only the caller's own undecided request, before eligibleAt too", async () => {
      prisma.settingsChangeRequest.findFirst.mockResolvedValue({
        id: "req-1",
        status: SettingsChangeStatus.WITHDRAWN,
      });

      const result = await service.withdrawRequest("user-1", "req-1", now);

      expect(result).toEqual({
        ok: true,
        request: { id: "req-1", status: SettingsChangeStatus.WITHDRAWN },
      });
      expect(prisma.settingsChangeRequest.updateMany).toHaveBeenCalledWith({
        where: {
          id: "req-1",
          userId: "user-1",
          status: {
            in: [
              SettingsChangeStatus.PENDING,
              SettingsChangeStatus.ELIGIBLE_FOR_REVIEW,
            ],
          },
        },
        data: { status: SettingsChangeStatus.WITHDRAWN, resolvedAt: now },
      });
    });

    it("is not_found for someone else's request", async () => {
      prisma.settingsChangeRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.settingsChangeRequest.findFirst.mockResolvedValue(null);

      await expect(
        service.withdrawRequest("user-2", "req-1", now),
      ).resolves.toEqual({ ok: false, reason: "not_found" });
    });

    it("cannot undo a decision that landed first", async () => {
      prisma.settingsChangeRequest.updateMany.mockResolvedValue({ count: 0 });
      prisma.settingsChangeRequest.findFirst.mockResolvedValue({
        id: "req-1",
        status: SettingsChangeStatus.APPROVED,
      });

      await expect(
        service.withdrawRequest("user-1", "req-1", now),
      ).resolves.toEqual({ ok: false, reason: "already_decided" });
    });
  });
});
