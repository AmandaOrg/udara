import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { HistoryController } from "./history.controller";
import { SpendSummaryQueryDto, TransactionsQueryDto } from "./history.dto";
import { encodeCursor } from "./transaction-history.service";

describe("HistoryController", () => {
  const principal = { userId: "me", deviceId: "d1", sessionId: "s1" };

  function build() {
    const history = {
      page: jest.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const summary = {
      weekStartDate: new Date("2026-09-21T00:00:00+01:00"),
      totalSpent: 4_000,
      byDay: [{ date: "2026-09-22", amount: 4_000 }],
      byLabel: { FOOD: 4_000 },
      transactionCount: 2,
    };
    const spend = {
      getWeeklySummary: jest.fn().mockResolvedValue(summary),
      getMonthlySummary: jest.fn().mockResolvedValue(summary),
    };
    return {
      history,
      spend,
      controller: new HistoryController(history as any, spend as any),
    };
  }

  it("pages the caller's own history from the decoded cursor", async () => {
    const { controller, history } = build();
    const at = new Date("2026-09-20T10:00:00Z");
    const id = "0b8e7c1e-8f7a-4d2b-9c1e-1a2b3c4d5e6f";

    await controller.transactions(principal, {
      cursor: encodeCursor({ at, id }),
      limit: 10,
    });

    expect(history.page).toHaveBeenCalledWith("me", { at, id }, 10);
  });

  it("refuses a cursor it did not issue", async () => {
    const { controller, history } = build();
    await expect(
      controller.transactions(principal, { cursor: "bm90LWEtY3Vyc29y" }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(history.page).not.toHaveBeenCalled();
  });

  it("summarises the week by default, and the month on request", async () => {
    const { controller, spend } = build();

    const week = await controller.spendSummary(principal, {});
    await controller.spendSummary(principal, { period: "month" });

    expect(week).toEqual({
      period: "week",
      periodStart: "2026-09-20T23:00:00.000Z",
      totalSpent: 4_000,
      transactionCount: 2,
      byDay: [{ date: "2026-09-22", amount: 4_000 }],
      byLabel: { FOOD: 4_000 },
    });
    expect(spend.getWeeklySummary).toHaveBeenCalledWith("me");
    expect(spend.getMonthlySummary).toHaveBeenCalledWith("me");
  });

  it.each([
    [{ limit: "20" }, true],
    [{ limit: "0" }, false],
    [{ limit: "51" }, false],
    [{ cursor: "abc DEF" }, false],
  ])("validates the transactions query %j", async (query, ok) => {
    const errors = await validate(plainToInstance(TransactionsQueryDto, query));
    expect(errors.length === 0).toBe(ok);
  });

  it("accepts only week or month", async () => {
    expect(
      await validate(plainToInstance(SpendSummaryQueryDto, { period: "year" })),
    ).toHaveLength(1);
  });
});
