import { ConflictException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { SettingsChangeStatus, SettingsChangeType } from "@prisma/client";
import { currentChannelContext } from "../../messaging/channel-context";
import { SettingsRequestsController } from "./settings-requests.controller";
import { CreateSettingsRequestDto } from "./settings-requests.dto";

describe("SettingsRequestsController", () => {
  const principal = { userId: "user-1", deviceId: "device-1", sessionId: "s1" };
  const at = new Date("2026-10-09T10:00:00Z");
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: "req-1",
    userId: "user-1",
    type: SettingsChangeType.WINDOW_HOURS,
    status: SettingsChangeStatus.PENDING,
    requestedChange: "open my window at 9am",
    reason: null,
    requestedAt: at,
    eligibleAt: new Date(at.getTime() + 7 * 86_400_000),
    resolvedAt: null,
    managerNotes: null,
    ...overrides,
  });
  let prisma: any;
  let managers: { fileChangeRequest: jest.Mock };
  let manager: { withdrawRequest: jest.Mock };
  let controller: SettingsRequestsController;

  beforeEach(() => {
    prisma = {
      settingsChangeRequest: {
        findMany: jest.fn().mockResolvedValue([row()]),
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    managers = { fileChangeRequest: jest.fn().mockResolvedValue(row()) };
    manager = { withdrawRequest: jest.fn() };
    controller = new SettingsRequestsController(
      prisma,
      managers as any,
      manager as any,
    );
  });

  it("lists only the caller's requests, newest first", async () => {
    const view = await controller.list(principal);

    expect(prisma.settingsChangeRequest.findMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
      orderBy: { requestedAt: "desc" },
      take: 50,
    });
    expect(view.requests[0]).toEqual({
      id: "req-1",
      type: "window_hours",
      status: "pending",
      requestedChange: "open my window at 9am",
      reason: null,
      requestedAt: at.toISOString(),
      eligibleAt: new Date(at.getTime() + 7 * 86_400_000).toISOString(),
      resolvedAt: null,
      managerNotes: null,
    });
  });

  it("files through the managers' path, inside the app's channel context", async () => {
    let channel: string | undefined;
    managers.fileChangeRequest.mockImplementation(async () => {
      channel = currentChannelContext()?.channel;
      return row();
    });

    await controller.file(principal, {
      type: "window_hours",
      requestedChange: "  open my window at 9am ",
      reason: " ",
    });

    expect(managers.fileChangeRequest).toHaveBeenCalledWith({
      userId: "user-1",
      type: SettingsChangeType.WINDOW_HOURS,
      requestedChange: "open my window at 9am",
      reason: undefined,
    });
    expect(channel).toBe("app");
  });

  it("refuses a second open request of the same kind", async () => {
    prisma.settingsChangeRequest.findFirst.mockResolvedValue(row());

    await expect(
      controller.file(principal, {
        type: "window_hours",
        requestedChange: "again",
      }),
    ).rejects.toThrow(ConflictException);
    expect(prisma.settingsChangeRequest.findFirst).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        type: SettingsChangeType.WINDOW_HOURS,
        status: {
          in: [
            SettingsChangeStatus.PENDING,
            SettingsChangeStatus.ELIGIBLE_FOR_REVIEW,
          ],
        },
      },
    });
    expect(managers.fileChangeRequest).not.toHaveBeenCalled();
  });

  it.each([
    [{ type: "window_hours", requestedChange: "9am please" }, true],
    [
      {
        type: "exit_restrictions",
        requestedChange: "let me out",
        reason: "done",
      },
      true,
    ],
    // Closing the account has its own route and its own checks (ADR-0003).
    [{ type: "account_deletion", requestedChange: "close it" }, false],
    [{ type: "ACCOUNT_DELETION", requestedChange: "close it" }, false],
    [{ type: "other", requestedChange: " " }, false],
    [{ type: "other", requestedChange: "x".repeat(501) }, false],
  ])("validates the request: %j", async (body, ok) => {
    const errors = await validate(
      plainToInstance(CreateSettingsRequestDto, body),
    );
    expect(errors.length === 0).toBe(ok);
  });

  it("withdraws the caller's own undecided request", async () => {
    manager.withdrawRequest.mockResolvedValue({
      ok: true,
      request: row({ status: SettingsChangeStatus.WITHDRAWN, resolvedAt: at }),
    });

    const view = await controller.withdraw(principal, "req-1");

    expect(manager.withdrawRequest).toHaveBeenCalledWith("user-1", "req-1");
    expect(view.status).toBe("withdrawn");
  });

  it("is a 404 for someone else's request and a 409 for a decided one", async () => {
    manager.withdrawRequest.mockResolvedValueOnce({
      ok: false,
      reason: "not_found",
    });
    await expect(controller.withdraw(principal, "req-9")).rejects.toThrow(
      NotFoundException,
    );

    manager.withdrawRequest.mockResolvedValueOnce({
      ok: false,
      reason: "already_decided",
    });
    await expect(controller.withdraw(principal, "req-1")).rejects.toThrow(
      ConflictException,
    );
  });
});
