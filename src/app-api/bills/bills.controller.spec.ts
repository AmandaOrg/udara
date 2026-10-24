import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BillsController } from "./bills.controller";
import { AuthorizeBillDto, CreateBillDto } from "./bills.dto";

describe("BillsController", () => {
  const principal = { userId: "me", deviceId: "d1", sessionId: "s1" };
  const dto = {
    category: "AIRTIME" as const,
    billerCode: "MTN_AIRTIME",
    target: "08000000000",
    amount: 500,
  };

  function build(replayed = false) {
    const native = {
      quote: jest.fn().mockResolvedValue({ replayed, view: { payment: {} } }),
    };
    const res = { status: jest.fn() };
    return { native, res, controller: new BillsController(native as any) };
  }

  it("offers what the WhatsApp wizards offer", () => {
    const catalog = build().controller.catalog();

    expect(catalog.airtime.networks.map((n) => n.label)).toEqual([
      "MTN",
      "Airtel",
      "Glo",
      "9mobile",
    ]);
    expect(catalog.airtime).toMatchObject({ minAmount: 50, maxAmount: 50_000 });
    expect(catalog.data.networks.every((n) => n.bundles.length > 0)).toBe(true);
    expect(catalog.electricity.companies[0]).toEqual({
      billerCode: "IKEDC",
      productCode: "IKEDC_PREPAID",
      label: "Ikeja Electric",
    });
  });

  /**
   * Express matches routes in the order they are registered, and Nest
   * registers a controller's routes in declaration order. If `:id` came
   * first, GET /v1/bills/catalog would be read as a purchase id.
   */
  it("declares the catalog before the purchase id route", () => {
    const methods = Object.getOwnPropertyNames(BillsController.prototype);
    expect(methods.indexOf("catalog")).toBeGreaterThan(-1);
    expect(methods.indexOf("catalog")).toBeLessThan(methods.indexOf("get"));
  });

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
    [{ ...dto, category: "GAMBLING" }, false],
    [{ ...dto, billerCode: "mtn airtime" }, false],
    [{ ...dto, target: "0".repeat(21) }, false],
    [{ ...dto, amount: 10.555 }, false],
    [{ ...dto, amount: undefined }, true],
    [
      {
        category: "DATA",
        billerCode: "MTN_DATA",
        productCode: "MTN_DATA_3.5GB_7D",
        target: "08000000000",
      },
      true,
    ],
    [{ ...dto, productCode: "x y" }, false],
  ])("validates a quote request %#", async (body, ok) => {
    const errors = await validate(plainToInstance(CreateBillDto, body));
    expect(errors.length === 0).toBe(ok);
  });

  it.each([
    [{ pinToken: "tok", pin: "1234" }, true],
    [{ pinToken: "tok", pin: "12345" }, false],
    [{ pin: "1234" }, false],
  ])("validates a PIN %#", async (body, ok) => {
    const errors = await validate(plainToInstance(AuthorizeBillDto, body));
    expect(errors.length === 0).toBe(ok);
  });
});
