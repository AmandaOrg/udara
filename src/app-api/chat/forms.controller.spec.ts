import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { FormsController } from "./forms.controller";
import { KycFormDto, PinFormDto } from "./chat.dto";

/** What the global ValidationPipe does with a body, minus Nest. */
async function problems<T extends object>(
  cls: new () => T,
  body: Record<string, unknown>,
): Promise<string[]> {
  const errors = await validate(plainToInstance(cls, body), {
    whitelist: true,
  });
  return errors.map((e) => e.property);
}

describe("FormsController", () => {
  const principal = { userId: "user-1", deviceId: "device-1", sessionId: "s1" };

  it("hands each form to the conversation service for the signed-in user", async () => {
    const chat = {
      submitKyc: jest.fn().mockResolvedValue({ id: "m1" }),
      submitPin: jest.fn().mockResolvedValue({ id: "m2" }),
    };
    const controller = new FormsController(chat as any);
    const kyc = {} as KycFormDto;
    const pin = {} as PinFormDto;

    await controller.kyc(principal, kyc);
    await controller.pin(principal, pin);

    expect(chat.submitKyc).toHaveBeenCalledWith(principal, kyc);
    expect(chat.submitPin).toHaveBeenCalledWith(principal, pin);
  });

  describe("the identity form's shape", () => {
    const valid = {
      clientMessageId: "c-00000001",
      token: "tok",
      firstName: "Daniel",
      lastName: "Okafor",
      idType: "NIN",
      idNumber: "12345678901",
      email: "me@example.com",
      dateOfBirth: "1998-04-12",
    };

    it("accepts a complete form", async () => {
      expect(await problems(KycFormDto, valid)).toEqual([]);
    });

    it.each([
      ["idNumber", "1234567890"],
      ["idNumber", "1234567890a"],
      ["idType", "PASSPORT"],
      ["email", "not-an-email"],
      ["dateOfBirth", "12/04/1998"],
      ["clientMessageId", "short"],
    ])("rejects a bad %s before anything is stored", async (field, value) => {
      expect(await problems(KycFormDto, { ...valid, [field]: value })).toEqual([
        field,
      ]);
    });
  });

  describe("the PIN form's shape", () => {
    it("accepts entry, setup and reset", async () => {
      const base = { clientMessageId: "c-00000001", token: "tok", pin: "4821" };
      expect(await problems(PinFormDto, base)).toEqual([]);
      expect(
        await problems(PinFormDto, { ...base, pinConfirm: "4821" }),
      ).toEqual([]);
      expect(
        await problems(PinFormDto, {
          ...base,
          pinConfirm: "4821",
          otp: "123456",
        }),
      ).toEqual([]);
    });

    it.each([
      ["pin", "48211"],
      ["pin", "48a1"],
      ["pinConfirm", "123"],
      ["otp", "12345"],
    ])("rejects a bad %s", async (field, value) => {
      expect(
        await problems(PinFormDto, {
          clientMessageId: "c-00000001",
          token: "tok",
          pin: "4821",
          [field]: value,
        }),
      ).toEqual([field]);
    });
  });
});
