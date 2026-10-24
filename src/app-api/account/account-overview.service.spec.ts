import { HttpException } from "@nestjs/common";
import { AccountOverviewService } from "./account-overview.service";

function build(user: Record<string, unknown>) {
  const prisma = {
    user: { findUniqueOrThrow: jest.fn().mockResolvedValue(user) },
  };
  const rubies = { getBalance: jest.fn().mockResolvedValue(12_345.5) };
  const allowance = {
    getRemainingSummary: jest.fn().mockResolvedValue({
      allowance: {},
      remainingToday: 3_000,
      remainingWeek: 15_000,
    }),
  };
  const windowService = {
    isWithinWindow: jest.fn().mockReturnValue(false),
    hoursUntilWindowOpens: jest.fn().mockReturnValue(2),
  };
  return {
    prisma,
    rubies,
    allowance,
    service: new AccountOverviewService(
      prisma as any,
      rubies as any,
      allowance as any,
      windowService as any,
    ),
  };
}

const opened = {
  id: "me",
  rubiesAccountNumber: "0000000009",
  rubiesAccountName: "UDARA/ADA OKAFOR",
  rubiesBankCode: null,
  disciplineExitedAt: null,
  windowStartHour: 11,
  windowEndHour: 20,
};

async function status(p: Promise<unknown>): Promise<number> {
  try {
    await p;
    return 200;
  } catch (err) {
    return (err as HttpException).getStatus();
  }
}

describe("AccountOverviewService", () => {
  it("reads only the caller's user row", async () => {
    const { service, prisma } = build(opened);
    await service.account("me");
    expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: "me" },
    });
  });

  it("returns the live balance for the caller's account", async () => {
    const { service, rubies } = build(opened);
    await expect(service.balance("me")).resolves.toEqual({ balance: 12_345.5 });
    expect(rubies.getBalance).toHaveBeenCalledWith("0000000009");
  });

  it("answers 503 when Rubies does not", async () => {
    const { service, rubies } = build(opened);
    rubies.getBalance.mockRejectedValue(new Error("timeout"));
    expect(await status(service.balance("me"))).toBe(503);
  });

  it("describes the limits and the window", async () => {
    const { service } = build(opened);
    await expect(service.limits("me")).resolves.toEqual({
      remainingToday: 3_000,
      remainingWeek: 15_000,
      restrictionsOff: false,
      window: { startHour: 11, endHour: 20, open: false, opensInHours: 2 },
    });
  });

  it("gives the funding details, defaulting the bank code to Rubies MFB", async () => {
    const { service } = build(opened);
    await expect(service.account("me")).resolves.toEqual({
      accountNumber: "0000000009",
      accountName: "UDARA/ADA OKAFOR",
      bankName: "Rubies MFB",
      bankCode: "090175",
    });
  });

  it("answers 409 for every figure before the account exists, without creating an allowance", async () => {
    const { service, allowance, rubies } = build({
      ...opened,
      rubiesAccountNumber: null,
    });
    expect(await status(service.balance("me"))).toBe(409);
    expect(await status(service.limits("me"))).toBe(409);
    expect(await status(service.account("me"))).toBe(409);
    expect(allowance.getRemainingSummary).not.toHaveBeenCalled();
    expect(rubies.getBalance).not.toHaveBeenCalled();
  });
});
