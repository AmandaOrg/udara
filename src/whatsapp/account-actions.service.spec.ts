import { AccountActionsService } from "./account-actions.service";
import {
  OnboardingStage,
  RecipientLabel,
  TransferDraftStatus,
  TransferDraftStep,
} from "@prisma/client";

/**
 * In-memory fake for TransferDraft — same rationale as
 * onboarding.service.spec.ts's fake Prisma: each wizard step makes several
 * sequential calls (find draft, update it, maybe send a follow-up), and
 * chaining mockResolvedValueOnce in the exact right order would be brittle.
 */
function createFakeDraftStore() {
  const drafts = new Map<string, Record<string, unknown>>();
  let counter = 0;

  return {
    transferDraft: {
      findFirst: jest.fn(async ({ where }: any) => {
        const found = [...drafts.values()]
          .filter((d) => d.userId === where.userId && d.status === where.status)
          .sort(
            (a: any, b: any) => b.createdAt.getTime() - a.createdAt.getTime(),
          )[0];
        return found ? { ...found } : null;
      }),
      findUniqueOrThrow: jest.fn(async ({ where: { id } }: any) => {
        const d = drafts.get(id);
        if (!d) throw new Error(`draft ${id} not found`);
        return { ...d };
      }),
      create: jest.fn(async ({ data }: any) => {
        counter += 1;
        const id = `draft-${counter}`;
        const d = {
          id,
          status: TransferDraftStatus.ACTIVE,
          createdAt: new Date(Date.now() + counter), // monotonically increasing for findFirst ordering
          updatedAt: new Date(),
          amount: null,
          accountNumber: null,
          bankCode: null,
          bankName: null,
          resolvedName: null,
          isNewRecipient: false,
          label: null,
          ...data,
        };
        drafts.set(id, d);
        return { ...d };
      }),
      update: jest.fn(async ({ where: { id }, data }: any) => {
        const updated = { ...drafts.get(id), ...data };
        drafts.set(id, updated);
        return { ...updated };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        let count = 0;
        for (const [id, d] of drafts.entries()) {
          if (d.userId === where.userId && d.status === where.status) {
            drafts.set(id, { ...d, ...data });
            count += 1;
          }
        }
        return { count };
      }),
    },
    dailyAllowance: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    _drafts: drafts,
  };
}

describe("AccountActionsService", () => {
  let prisma: ReturnType<typeof createFakeDraftStore>;
  let allowance: { getOrCreateTodayAllowance: jest.Mock };
  let windowService: {
    isWithinWindow: jest.Mock;
    hoursUntilWindowOpens: jest.Mock;
  };
  let rubies: {
    getBalance: jest.Mock;
    listBanks: jest.Mock;
    nameEnquiry: jest.Mock;
  };
  let tagging: { findRecipient: jest.Mock };
  let whatsapp: { sendText: jest.Mock; sendListMessage: jest.Mock };
  let transferConfirmation: { initiateTransfer: jest.Mock };
  let service: AccountActionsService;

  function makeUser(overrides: Record<string, unknown> = {}) {
    return {
      id: "user-1",
      whatsappNumber: "234801",
      onboardingStage: OnboardingStage.COMPLETE,
      rubiesAccountNumber: "0123456789",
      rubiesAccountName: "Daniel Okafor",
      windowStartHour: 11,
      windowEndHour: 20,
      disciplineExitedAt: null,
      ...overrides,
    };
  }

  const banks = [
    { bankCode: "000004", bankName: "Access Bank" },
    { bankCode: "000013", bankName: "GTBank" },
    { bankCode: "000015", bankName: "Zenith Bank" },
  ];

  beforeEach(() => {
    prisma = createFakeDraftStore();
    allowance = { getOrCreateTodayAllowance: jest.fn() };
    windowService = {
      isWithinWindow: jest.fn().mockReturnValue(true),
      hoursUntilWindowOpens: jest.fn().mockReturnValue(3),
    };
    rubies = {
      getBalance: jest.fn(),
      listBanks: jest.fn().mockResolvedValue(banks),
      nameEnquiry: jest.fn(),
    };
    tagging = { findRecipient: jest.fn().mockResolvedValue(null) };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "wamid.1" }),
      sendListMessage: jest.fn().mockResolvedValue({ waMessageId: "wamid.2" }),
    };
    transferConfirmation = { initiateTransfer: jest.fn() };

    service = new AccountActionsService(
      prisma as any,
      allowance as any,
      windowService as any,
      rubies as any,
      tagging as any,
      whatsapp as any,
      transferConfirmation as any,
    );
  });

  describe("sendMainMenu", () => {
    it("sends a list message with all four actions", async () => {
      await service.sendMainMenu(makeUser() as any);
      expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
        "234801",
        expect.any(String),
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ id: "menu:balance" }),
          expect.objectContaining({ id: "menu:limits" }),
          expect.objectContaining({ id: "menu:account" }),
          expect.objectContaining({ id: "menu:transfer" }),
        ]),
        "user-1",
      );
    });
  });

  describe("sendBalance", () => {
    it("sends the live Rubies balance", async () => {
      rubies.getBalance.mockResolvedValue(52_500);
      await service.sendBalance(makeUser() as any);
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("₦52,500"),
        "user-1",
      );
    });

    it("tells the user plainly if there's no account yet", async () => {
      await service.sendBalance(makeUser({ rubiesAccountNumber: null }) as any);
      expect(rubies.getBalance).not.toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("don't have a udara account"),
        "user-1",
      );
    });

    it("gives a friendly message on a Rubies failure instead of throwing", async () => {
      rubies.getBalance.mockRejectedValue(new Error("timeout"));
      await service.sendBalance(makeUser() as any);
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("couldn't reach rubies"),
        "user-1",
      );
    });
  });

  describe("sendLimitsStatus", () => {
    it("shows remaining today/week and window-open status", async () => {
      allowance.getOrCreateTodayAllowance.mockResolvedValue({
        amountAllocated: 10_000,
        surplusCarriedIn: 0,
        amountSpent: 2_000,
        weekStartDate: new Date("2026-01-05"),
      });
      windowService.isWithinWindow.mockReturnValue(true);

      await service.sendLimitsStatus(makeUser() as any);

      const [, text] = whatsapp.sendText.mock.calls[0];
      expect(text).toContain("₦8,000");
      expect(text).toContain("window is open");
    });

    it("shows time until reopen when the window is closed", async () => {
      allowance.getOrCreateTodayAllowance.mockResolvedValue({
        amountAllocated: 10_000,
        surplusCarriedIn: 0,
        amountSpent: 0,
        weekStartDate: new Date("2026-01-05"),
      });
      windowService.isWithinWindow.mockReturnValue(false);
      windowService.hoursUntilWindowOpens.mockReturnValue(5);

      await service.sendLimitsStatus(makeUser() as any);

      const [, text] = whatsapp.sendText.mock.calls[0];
      expect(text).toContain("closed");
      expect(text).toContain("5h");
    });

    it("says restrictions are off when disciplineExitedAt is set, without checking the window", async () => {
      allowance.getOrCreateTodayAllowance.mockResolvedValue({
        amountAllocated: 10_000,
        surplusCarriedIn: 0,
        amountSpent: 0,
        weekStartDate: new Date("2026-01-05"),
      });

      await service.sendLimitsStatus(
        makeUser({ disciplineExitedAt: new Date() }) as any,
      );

      const [, text] = whatsapp.sendText.mock.calls[0];
      expect(text).toContain("restrictions are off");
      expect(windowService.isWithinWindow).not.toHaveBeenCalled();
    });
  });

  describe("sendAccountDetails", () => {
    it("shows account number/name/bank", async () => {
      await service.sendAccountDetails(makeUser() as any);
      const [, text] = whatsapp.sendText.mock.calls[0];
      expect(text).toContain("0123456789");
      expect(text).toContain("Daniel Okafor");
      expect(text).toContain("rubies mfb");
    });
  });

  describe("send-money wizard", () => {
    it("startTransferWizard creates a draft and asks for an amount", async () => {
      await service.startTransferWizard(makeUser() as any);
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("how much"),
        "user-1",
      );
      const draft = await service.getActiveDraft("user-1");
      expect(draft?.step).toBe(TransferDraftStep.AWAITING_AMOUNT);
    });

    it("refuses to start without a Rubies account", async () => {
      await service.startTransferWizard(
        makeUser({ rubiesAccountNumber: null }) as any,
      );
      expect(await service.getActiveDraft("user-1")).toBeNull();
    });

    it("cancels a stale active draft when starting fresh", async () => {
      await service.startTransferWizard(makeUser() as any);
      const first = await service.getActiveDraft("user-1");
      await service.startTransferWizard(makeUser() as any);
      const stale = prisma._drafts.get(first!.id)!;
      expect(stale.status).toBe(TransferDraftStatus.CANCELLED);
    });

    it("rejects an invalid amount and stays on the same step", async () => {
      await service.startTransferWizard(makeUser() as any);
      const draft = await service.getActiveDraft("user-1");
      await service.handleWizardText(
        makeUser() as any,
        draft!.id,
        "not a number",
      );
      expect(whatsapp.sendText).toHaveBeenLastCalledWith(
        "234801",
        expect.stringContaining("valid amount"),
        "user-1",
      );
      expect(prisma._drafts.get(draft!.id)!.step).toBe(
        TransferDraftStep.AWAITING_AMOUNT,
      );
    });

    it("accepts an amount and asks for the account number", async () => {
      await service.startTransferWizard(makeUser() as any);
      const draft = await service.getActiveDraft("user-1");
      await service.handleWizardText(makeUser() as any, draft!.id, "5,000");
      expect(prisma._drafts.get(draft!.id)!.amount).toBe(5000);
      expect(prisma._drafts.get(draft!.id)!.step).toBe(
        TransferDraftStep.AWAITING_ACCOUNT_NUMBER,
      );
      expect(whatsapp.sendText).toHaveBeenLastCalledWith(
        "234801",
        expect.stringContaining("account number"),
        "user-1",
      );
    });

    it("rejects a non-10-digit account number", async () => {
      await service.startTransferWizard(makeUser() as any);
      const draft = await service.getActiveDraft("user-1");
      await service.handleWizardText(makeUser() as any, draft!.id, "5000");
      await service.handleWizardText(makeUser() as any, draft!.id, "12345");
      expect(whatsapp.sendText).toHaveBeenLastCalledWith(
        "234801",
        expect.stringContaining("10-digit"),
        "user-1",
      );
      expect(prisma._drafts.get(draft!.id)!.step).toBe(
        TransferDraftStep.AWAITING_ACCOUNT_NUMBER,
      );
    });

    it("cancels at any step on a cancel word", async () => {
      await service.startTransferWizard(makeUser() as any);
      const draft = await service.getActiveDraft("user-1");
      await service.handleWizardText(makeUser() as any, draft!.id, "cancel");
      expect(prisma._drafts.get(draft!.id)!.status).toBe(
        TransferDraftStatus.CANCELLED,
      );
      expect(whatsapp.sendText).toHaveBeenLastCalledWith(
        "234801",
        "cancelled.",
        "user-1",
      );
    });

    async function driveToBankStep() {
      await service.startTransferWizard(makeUser() as any);
      const draft = await service.getActiveDraft("user-1");
      await service.handleWizardText(makeUser() as any, draft!.id, "5000");
      await service.handleWizardText(
        makeUser() as any,
        draft!.id,
        "0123456789",
      );
      return draft!.id;
    }

    it("resolves a single bank-name match directly, running name-enquiry", async () => {
      const draftId = await driveToBankStep();
      rubies.nameEnquiry.mockResolvedValue({
        accountName: "Jane Doe",
        bankName: "GTBank",
      });

      await service.handleWizardText(makeUser() as any, draftId, "gtbank");

      expect(rubies.nameEnquiry).toHaveBeenCalledWith({
        accountNumber: "0123456789",
        bankCode: "000013",
      });
      // New recipient -> label-selection list sent
      expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("Jane Doe"),
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ id: "label:RENT" }),
          expect.objectContaining({ id: "label:OTHER" }),
        ]),
        "user-1",
      );
      expect(prisma._drafts.get(draftId)!.step).toBe(
        TransferDraftStep.AWAITING_LABEL_SELECTION,
      );
    });

    it("shows a list to disambiguate multiple bank-name matches", async () => {
      const draftId = await driveToBankStep();
      await service.handleWizardText(makeUser() as any, draftId, "bank");

      expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
        "234801",
        expect.any(String),
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ id: "bank:000004" }),
          expect.objectContaining({ id: "bank:000013" }),
          expect.objectContaining({ id: "bank:000015" }),
        ]),
        "user-1",
      );
      expect(rubies.nameEnquiry).not.toHaveBeenCalled();
    });

    it("tells the user when no bank matches", async () => {
      const draftId = await driveToBankStep();
      await service.handleWizardText(
        makeUser() as any,
        draftId,
        "not a real bank",
      );
      expect(whatsapp.sendText).toHaveBeenLastCalledWith(
        "234801",
        expect.stringContaining("couldn't find that bank"),
        "user-1",
      );
    });

    it("resolves via a bank list-reply the same way as a text match", async () => {
      const draftId = await driveToBankStep();
      rubies.nameEnquiry.mockResolvedValue({
        accountName: "Jane Doe",
        bankName: "GTBank",
      });

      await service.handleWizardSelection(
        makeUser() as any,
        draftId,
        "bank:000013",
      );

      expect(rubies.nameEnquiry).toHaveBeenCalledWith({
        accountNumber: "0123456789",
        bankCode: "000013",
      });
    });

    it("on a failed name-enquiry: sends back to re-enter the account number", async () => {
      const draftId = await driveToBankStep();
      rubies.nameEnquiry.mockRejectedValue(new Error("not found"));

      await service.handleWizardText(makeUser() as any, draftId, "gtbank");

      const draft = prisma._drafts.get(draftId)!;
      expect(draft.step).toBe(TransferDraftStep.AWAITING_ACCOUNT_NUMBER);
      expect(draft.accountNumber).toBeNull();
      expect(whatsapp.sendText).toHaveBeenLastCalledWith(
        "234801",
        expect.stringContaining("couldn't verify that account"),
        "user-1",
      );
    });

    it("skips label-selection and finalizes directly for an already-tagged recipient", async () => {
      tagging.findRecipient.mockResolvedValue({
        id: "recipient-1",
        label: RecipientLabel.VENDOR,
      });
      rubies.nameEnquiry.mockResolvedValue({
        accountName: "Jane Doe",
        bankName: "GTBank",
      });
      const draftId = await driveToBankStep();

      await service.handleWizardText(makeUser() as any, draftId, "gtbank");

      expect(whatsapp.sendListMessage).not.toHaveBeenCalled(); // no label prompt
      expect(transferConfirmation.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: "user-1",
          accountNumber: "0123456789",
          bankCode: "000013",
          amount: 5000,
          resolvedName: "Jane Doe",
          label: RecipientLabel.VENDOR,
        }),
      );
      expect(prisma._drafts.get(draftId)!.status).toBe(
        TransferDraftStatus.COMPLETED,
      );
    });

    it("finalizes a new recipient once a label is picked", async () => {
      rubies.nameEnquiry.mockResolvedValue({
        accountName: "Jane Doe",
        bankName: "GTBank",
      });
      const draftId = await driveToBankStep();
      await service.handleWizardText(makeUser() as any, draftId, "gtbank");

      await service.handleWizardSelection(
        makeUser() as any,
        draftId,
        "label:RENT",
      );

      expect(transferConfirmation.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          accountNumber: "0123456789",
          bankCode: "000013",
          amount: 5000,
          resolvedName: "Jane Doe",
          label: RecipientLabel.RENT,
        }),
      );
      expect(prisma._drafts.get(draftId)!.status).toBe(
        TransferDraftStatus.COMPLETED,
      );
    });

    it("ignores a bank/label selection that doesn't match the draft's current step", async () => {
      const draftId = await driveToBankStep(); // step is AWAITING_BANK_SELECTION
      await service.handleWizardSelection(
        makeUser() as any,
        draftId,
        "label:RENT", // premature — no bank/name resolved yet
      );
      expect(transferConfirmation.initiateTransfer).not.toHaveBeenCalled();
      expect(whatsapp.sendText).toHaveBeenLastCalledWith(
        "234801",
        expect.stringContaining("doesn't match"),
        "user-1",
      );
    });
  });
});
