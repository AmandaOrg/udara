import { ServiceUnavailableException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { BanksController } from "./banks.controller";
import { NameEnquiryDto } from "./banks.dto";

describe("BanksController", () => {
  const principal = { userId: "me", deviceId: "d1", sessionId: "s1" };

  it("lists banks as code and name", async () => {
    const directory = {
      list: jest
        .fn()
        .mockResolvedValue([{ bankCode: "000005", bankName: "Access Bank" }]),
    };
    const controller = new BanksController(directory as any, {} as any);
    await expect(controller.banks()).resolves.toEqual({
      banks: [{ code: "000005", name: "Access Bank" }],
    });
  });

  it("answers 503 rather than an empty list", async () => {
    const directory = { list: jest.fn().mockResolvedValue([]) };
    const controller = new BanksController(directory as any, {} as any);
    await expect(controller.banks()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it("looks up names as the caller, from the session", async () => {
    const nameEnquiry = {
      lookup: jest.fn().mockResolvedValue({ accountName: "ADA OKAFOR" }),
    };
    const controller = new BanksController({} as any, nameEnquiry as any);
    await controller.lookup(principal, {
      accountNumber: "0000000001",
      bankCode: "000005",
    });
    expect(nameEnquiry.lookup).toHaveBeenCalledWith(
      "me",
      "0000000001",
      "000005",
    );
  });

  it.each([
    [{ accountNumber: "0000000001", bankCode: "000005" }, true],
    [{ accountNumber: "000000001", bankCode: "000005" }, false],
    [{ accountNumber: "00000000011", bankCode: "000005" }, false],
    [{ accountNumber: "000000000a", bankCode: "000005" }, false],
    [{ accountNumber: "0000000001", bankCode: "ACCESS" }, false],
  ])("validates %j", async (body, ok) => {
    const errors = await validate(plainToInstance(NameEnquiryDto, body));
    expect(errors.length === 0).toBe(ok);
  });
});
