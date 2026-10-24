import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { TransfersController } from "./transfers.controller";
import { AuthorizeTransferDto, CreateTransferDto } from "./transfers.dto";

describe("TransfersController", () => {
  const principal = { userId: "me", deviceId: "d1", sessionId: "s1" };
  const dto = { accountNumber: "0000000001", bankCode: "000005", amount: 500 };

  function build(replayed = false) {
    const native = {
      quote: jest.fn().mockResolvedValue({ replayed, view: { transfer: {} } }),
    };
    const res = { status: jest.fn() };
    return {
      native,
      res,
      controller: new TransfersController(native as any),
    };
  }

  it.each([undefined, "", "short", "has spaces in it", "x".repeat(65)])(
    "refuses to quote without a well-formed Idempotency-Key (%p)",
    async (key) => {
      const { controller, native, res } = build();
      await expect(
        controller.create(principal, key, dto, res as any),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(native.quote).not.toHaveBeenCalled();
    },
  );

  it("answers a new quote with 201 and a replay with 200", async () => {
    const fresh = build(false);
    await fresh.controller.create(
      principal,
      "key-12345678",
      dto,
      fresh.res as any,
    );
    expect(fresh.native.quote).toHaveBeenCalledWith(
      principal,
      "key-12345678",
      dto,
    );
    expect(fresh.res.status).toHaveBeenCalledWith(201);

    const again = build(true);
    await again.controller.create(
      principal,
      "key-12345678",
      dto,
      again.res as any,
    );
    expect(again.res.status).toHaveBeenCalledWith(200);
  });

  it.each([
    [dto, true],
    [{ ...dto, amount: 0 }, false],
    [{ ...dto, amount: 10.555 }, false],
    [{ ...dto, amount: 10_000_001 }, false],
    [{ ...dto, accountNumber: "123" }, false],
    [{ ...dto, purpose: "RENT" }, true],
    [{ ...dto, purpose: "GAMBLING" }, false],
    [{ ...dto, note: "x".repeat(201) }, false],
  ])("validates a quote request %#", async (body, ok) => {
    const errors = await validate(plainToInstance(CreateTransferDto, body));
    expect(errors.length === 0).toBe(ok);
  });

  it.each([
    [{ pinToken: "tok", pin: "1234" }, true],
    [{ pinToken: "tok", pin: "123" }, false],
    [{ pinToken: "tok", pin: "12a4" }, false],
    [{ pin: "1234" }, false],
  ])("validates a PIN %#", async (body, ok) => {
    const errors = await validate(plainToInstance(AuthorizeTransferDto, body));
    expect(errors.length === 0).toBe(ok);
  });
});
