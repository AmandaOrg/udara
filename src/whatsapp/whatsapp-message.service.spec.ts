import { WhatsappMessageService } from "./whatsapp-message.service";
import { WhatsappMessageType } from "@prisma/client";

/**
 * The security-critical half of this suite is the persistence boundary: this
 * service is the *only* place that can keep a secret out of the database,
 * because WhatsappController persists here and only then routes. Anything
 * asserted below about "never written" is a guarantee no downstream handler
 * can restore if it breaks.
 */
describe("WhatsappMessageService", () => {
  let prisma: {
    whatsappMessage: { findUnique: jest.Mock; create: jest.Mock };
  };
  let service: WhatsappMessageService;

  /** The row that would have been written, for inspection. */
  function persistedData() {
    return prisma.whatsappMessage.create.mock.calls[0][0].data;
  }

  beforeEach(() => {
    prisma = {
      whatsappMessage: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn(async ({ data }: any) => ({ id: "m1", ...data })),
      },
    };
    service = new WhatsappMessageService(prisma as any);
  });

  function flowReply(responseJson: Record<string, unknown>) {
    return {
      waMessageId: "wamid.1",
      type: WhatsappMessageType.FLOW_REPLY,
      from: "234801",
      timestamp: "1700000000",
      responseJson,
    } as const;
  }

  /** The real Meta envelope, with answers as a JSON-encoded string. */
  function rawEnvelope(responseJson: Record<string, unknown>) {
    return {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    interactive: {
                      type: "nfm_reply",
                      nfm_reply: {
                        name: "flow",
                        body: "Sent",
                        response_json: JSON.stringify(responseJson),
                      },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
  }

  describe("PIN submissions", () => {
    const submission = { pin: "8317", flow_token: "tok-1" };

    it("never writes the PIN to flowResponseJson", async () => {
      await service.recordInboundIfNew(
        flowReply(submission),
        rawEnvelope(submission),
      );

      expect(JSON.stringify(persistedData().flowResponseJson)).not.toContain(
        "8317",
      );
    });

    it("never writes the PIN to rawPayload either, including inside the encoded response_json", async () => {
      await service.recordInboundIfNew(
        flowReply(submission),
        rawEnvelope(submission),
      );

      expect(JSON.stringify(persistedData().rawPayload)).not.toContain("8317");
    });

    it("returns the PIN in memory so it can actually be verified", async () => {
      const { sensitive } = await service.recordInboundIfNew(
        flowReply(submission),
        rawEnvelope(submission),
      );

      expect(sensitive).toEqual({ pin: "8317" });
    });

    it("keeps flow_token, which the challenge lookup needs and which isn't a secret", async () => {
      await service.recordInboundIfNew(
        flowReply(submission),
        rawEnvelope(submission),
      );

      expect(
        (persistedData().flowResponseJson as Record<string, unknown>)
          .flow_token,
      ).toBe("tok-1");
    });

    it("carries both PIN fields through on a setup submission", async () => {
      const setup = { pin: "8317", pin_confirm: "8317", flow_token: "tok-2" };
      const { sensitive } = await service.recordInboundIfNew(
        flowReply(setup),
        rawEnvelope(setup),
      );

      expect(sensitive).toEqual({ pin: "8317", pin_confirm: "8317" });
      expect(JSON.stringify(persistedData())).not.toContain("8317");
    });
  });

  describe("KYC submissions (the leak this closes)", () => {
    const kyc = {
      first_name: "Ikechukwu",
      id_number: "12345678901",
      date_of_birth: "1998-04-12",
      email: "me@example.com",
      flow_token: "tok-3",
    };

    it("never writes the BVN/NIN to either column", async () => {
      await service.recordInboundIfNew(flowReply(kyc), rawEnvelope(kyc));

      const written = JSON.stringify(persistedData());
      expect(written).not.toContain("12345678901");
      expect(written).not.toContain("1998-04-12");
    });

    it("still writes the non-sensitive fields, so the row stays useful", async () => {
      await service.recordInboundIfNew(flowReply(kyc), rawEnvelope(kyc));

      const written = JSON.stringify(persistedData());
      expect(written).toContain("Ikechukwu");
      expect(written).toContain("me@example.com");
    });

    it("hands the ID and DOB onward in memory so provisioning still works", async () => {
      const { sensitive } = await service.recordInboundIfNew(
        flowReply(kyc),
        rawEnvelope(kyc),
      );

      expect(sensitive).toEqual({
        id_number: "12345678901",
        date_of_birth: "1998-04-12",
      });
    });
  });

  describe("ordinary messages", () => {
    it("persists plain text unchanged and returns no sensitive fields", async () => {
      const { sensitive } = await service.recordInboundIfNew(
        {
          waMessageId: "wamid.2",
          type: WhatsappMessageType.TEXT,
          from: "234801",
          timestamp: "1700000000",
          text: "what's my balance",
        } as any,
        { some: "payload" },
      );

      expect(persistedData().textBody).toBe("what's my balance");
      expect(sensitive).toEqual({});
    });

    it("returns isNew: false and no sensitive data for a STATUS callback", async () => {
      const result = await service.recordInboundIfNew(
        {
          waMessageId: "wamid.3",
          type: WhatsappMessageType.STATUS,
          status: "delivered",
        } as any,
        {},
      );

      expect(result).toEqual({ isNew: false, record: null, sensitive: {} });
      expect(prisma.whatsappMessage.create).not.toHaveBeenCalled();
    });

    it("treats a redelivered message as not-new without writing twice", async () => {
      prisma.whatsappMessage.findUnique.mockResolvedValue({ id: "existing" });

      const { isNew, record } = await service.recordInboundIfNew(
        flowReply({ pin: "8317" }),
        rawEnvelope({ pin: "8317" }),
      );

      expect(isNew).toBe(false);
      expect(record).toEqual({ id: "existing" });
      expect(prisma.whatsappMessage.create).not.toHaveBeenCalled();
    });

    it("still surfaces the PIN in memory on a redelivery, so a retried webhook can be handled", async () => {
      prisma.whatsappMessage.findUnique.mockResolvedValue({ id: "existing" });

      const { sensitive } = await service.recordInboundIfNew(
        flowReply({ pin: "8317" }),
        rawEnvelope({ pin: "8317" }),
      );

      expect(sensitive).toEqual({ pin: "8317" });
    });
  });
});
