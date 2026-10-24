import { AccountActionsService } from "./account-actions.service";
import {
  OnboardingStage,
  RecipientLabel,
  TransferDraftStatus,
  TransferDraftStep,
} from "@prisma/client";
import { whatsappTestMessenger } from "../messaging/testing/whatsapp-test-messenger";

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
  let allowance: {
    getOrCreateTodayAllowance: jest.Mock;
    getRemainingSummary: jest.Mock;
  };
  let windowService: {
    isWithinWindow: jest.Mock;
    hoursUntilWindowOpens: jest.Mock;
  };
  let rubies: {
    getBalance: jest.Mock;
    listBanks: jest.Mock;
    nameEnquiry: jest.Mock;
  };
  let tagging: {
    findRecipient: jest.Mock;
    matchBeneficiaryByName: jest.Mock;
    findAmbiguousBeneficiaryMatches: jest.Mock;
    listRecipientsForUser: jest.Mock;
  };
  let whatsapp: { sendText: jest.Mock; sendListMessage: jest.Mock };
  let transferConfirmation: {
    initiateTransfer: jest.Mock;
    cancelPendingForUser: jest.Mock;
    resumePendingTransferUi: jest.Mock;
  };
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
    allowance = {
      getOrCreateTodayAllowance: jest.fn(),
      getRemainingSummary: jest.fn(),
    };
    windowService = {
      isWithinWindow: jest.fn().mockReturnValue(true),
      hoursUntilWindowOpens: jest.fn().mockReturnValue(3),
    };
    rubies = {
      getBalance: jest.fn(),
      listBanks: jest.fn().mockResolvedValue(banks),
      nameEnquiry: jest.fn(),
    };
    tagging = {
      findRecipient: jest.fn().mockResolvedValue(null),
      matchBeneficiaryByName: jest.fn().mockResolvedValue(null),
      findAmbiguousBeneficiaryMatches: jest.fn().mockResolvedValue([]),
      listRecipientsForUser: jest.fn().mockResolvedValue([]),
    };
    whatsapp = {
      sendText: jest.fn().mockResolvedValue({ waMessageId: "wamid.1" }),
      sendListMessage: jest.fn().mockResolvedValue({ waMessageId: "wamid.2" }),
    };
    (prisma as any).conversationSession = {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({ id: "sess-1", contextData: {} }),
      update: jest.fn().mockResolvedValue({ id: "sess-1", contextData: {} }),
    };
    (prisma as any).recipient = {
      findFirst: jest.fn(),
    };
    transferConfirmation = {
      initiateTransfer: jest.fn(),
      cancelPendingForUser: jest.fn().mockResolvedValue(undefined),
      resumePendingTransferUi: jest.fn().mockResolvedValue(false),
    };
    const billPaymentActions = {
      cancelActiveDraftForUser: jest.fn().mockResolvedValue(undefined),
    };
    const billPaymentConfirmation = {
      cancelPendingForUser: jest.fn().mockResolvedValue(undefined),
    };

    service = new AccountActionsService(
      prisma as any,
      allowance as any,
      windowService as any,
      rubies as any,
      tagging as any,
      whatsappTestMessenger({ whatsapp }),
      transferConfirmation as any,
      billPaymentActions as any,
      billPaymentConfirmation as any,
    );
  });

  describe("sendMainMenu", () => {
    it("sends a capability list then a list message with all menu actions", async () => {
      await service.sendMainMenu(makeUser() as any);
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("buy airtime, data, or prepaid electricity"),
        "user-1",
      );
      expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
        "234801",
        expect.any(String),
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ id: "menu:balance" }),
          expect.objectContaining({ id: "menu:limits" }),
          expect.objectContaining({ id: "menu:account" }),
          expect.objectContaining({ id: "menu:transfer" }),
          expect.objectContaining({ id: "menu:airtime" }),
          expect.objectContaining({ id: "menu:data" }),
          expect.objectContaining({ id: "menu:electricity" }),
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
      allowance.getRemainingSummary.mockResolvedValue({
        allowance: {},
        remainingToday: 8_000,
        remainingWeek: 30_000,
      });
      windowService.isWithinWindow.mockReturnValue(true);

      await service.sendLimitsStatus(makeUser() as any);

      const [, text] = whatsapp.sendText.mock.calls[0];
      expect(text).toContain("₦8,000");
      expect(text).toContain("window is open");
    });

    it("shows time until reopen when the window is closed", async () => {
      allowance.getRemainingSummary.mockResolvedValue({
        allowance: {},
        remainingToday: 10_000,
        remainingWeek: 40_000,
      });
      windowService.isWithinWindow.mockReturnValue(false);
      windowService.hoursUntilWindowOpens.mockReturnValue(5);

      await service.sendLimitsStatus(makeUser() as any);

      const [, text] = whatsapp.sendText.mock.calls[0];
      expect(text).toContain("closed");
      expect(text).toContain("5h");
    });

    it("says restrictions are off when disciplineExitedAt is set, without checking the window", async () => {
      allowance.getRemainingSummary.mockResolvedValue({
        allowance: {},
        remainingToday: 10_000,
        remainingWeek: 40_000,
      });

      await service.sendLimitsStatus(
        makeUser({ disciplineExitedAt: new Date() }) as any,
      );

      const [, text] = whatsapp.sendText.mock.calls[0];
      expect(text).toContain("restrictions are off");
      expect(windowService.isWithinWindow).not.toHaveBeenCalled();
    });

    // The text as it was before describeLimits was extracted for /v1/limits.
    it.each([
      [
        { disciplineExitedAt: null },
        true,
        "today's remaining allowance: ₦1,500\nremaining this week: ₦9,000\nspending window is open until 20:00.",
      ],
      [
        { disciplineExitedAt: null },
        false,
        "today's remaining allowance: ₦1,500\nremaining this week: ₦9,000\nspending window is closed, opens in about 4h (11:00).",
      ],
      [
        { disciplineExitedAt: new Date() },
        false,
        "today's remaining allowance: ₦1,500\nremaining this week: ₦9,000\nrestrictions are off for your account, the spending window and override fees don't apply.",
      ],
    ])("renders the exact text (%#)", async (overrides, open, expected) => {
      allowance.getRemainingSummary.mockResolvedValue({
        allowance: {},
        remainingToday: 1_500,
        remainingWeek: 9_000,
      });
      windowService.isWithinWindow.mockReturnValue(open);
      windowService.hoursUntilWindowOpens.mockReturnValue(4);

      await service.sendLimitsStatus(
        makeUser({
          ...overrides,
          windowStartHour: 11,
          windowEndHour: 20,
        }) as any,
      );

      expect(whatsapp.sendText.mock.calls[0][1]).toBe(expected);
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
    it("startTransferWizard with amount hint skips to account-number step", async () => {
      await service.startTransferWizard(makeUser() as any, { amount: 15000 });

      const draft = await service.getActiveDraft("user-1");
      expect(draft?.step).toBe(TransferDraftStep.AWAITING_ACCOUNT_NUMBER);
      expect(Number(draft?.amount)).toBe(15000);
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("₦15,000"),
        "user-1",
      );
    });

    it("startTransferWizard with full hints runs name-enquiry and skips label when label_hint is set", async () => {
      rubies.nameEnquiry.mockResolvedValue({
        accountName: "Jane Doe",
        bankName: "GTBank",
      });
      tagging.findRecipient.mockResolvedValue(null);

      await service.startTransferWizard(makeUser() as any, {
        amount: 5000,
        accountNumber: "0011223344",
        bankName: "gtbank",
        labelHint: RecipientLabel.RENT,
      });

      expect(rubies.nameEnquiry).toHaveBeenCalledWith({
        accountNumber: "0011223344",
        bankCode: "000013",
      });
      expect(transferConfirmation.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          accountNumber: "0011223344",
          bankCode: "000013",
          amount: 5000,
          resolvedName: "Jane Doe",
          label: RecipientLabel.RENT,
        }),
      );
      expect(whatsapp.sendListMessage).not.toHaveBeenCalled();
    });

    it("startTransferWizard with amount+account+bank shows bank list when bank name is ambiguous", async () => {
      await service.startTransferWizard(makeUser() as any, {
        amount: 5000,
        accountNumber: "0011223344",
        bankName: "bank",
      });

      expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
        "234801",
        expect.any(String),
        expect.any(String),
        expect.arrayContaining([
          expect.objectContaining({ id: "bank:000004" }),
          expect.objectContaining({ id: "bank:000013" }),
        ]),
        "user-1",
      );
      expect(rubies.nameEnquiry).not.toHaveBeenCalled();
    });

    it("startTransferWizard with account+bank prefilled asks only for amount", async () => {
      await service.startTransferWizard(makeUser() as any, {
        accountNumber: "0011223344",
        bankCode: "000013",
        bankName: "GTBank",
      });

      const draft = await service.getActiveDraft("user-1");
      expect(draft?.step).toBe(TransferDraftStep.AWAITING_AMOUNT);
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("how much"),
        "user-1",
      );
    });

    it("startTransferWizard with amount+bank prefilled asks only for account number", async () => {
      await service.startTransferWizard(makeUser() as any, {
        amount: 8000,
        bankName: "gtbank",
      });

      const draft = await service.getActiveDraft("user-1");
      expect(draft?.step).toBe(TransferDraftStep.AWAITING_ACCOUNT_NUMBER);
      expect(Number(draft?.amount)).toBe(8000);
      expect(draft?.bankCode).toBe("000013");
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringMatching(/₦8,000.*account number/i),
        "user-1",
      );
    });

    it("startTransferWizard with amount+account prefilled asks only for bank", async () => {
      await service.startTransferWizard(makeUser() as any, {
        amount: 3000,
        accountNumber: "0011223344",
      });

      const draft = await service.getActiveDraft("user-1");
      expect(draft?.step).toBe(TransferDraftStep.AWAITING_BANK_SELECTION);
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringMatching(/₦3,000.*0011223344.*which bank/i),
        "user-1",
      );
    });

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
        expect.stringContaining("amount"),
        "user-1",
      );
      expect(prisma._drafts.get(draft!.id)!.step).toBe(
        TransferDraftStep.AWAITING_AMOUNT,
      );
    });

    it("accepts a linguistic 5k amount", async () => {
      await service.startTransferWizard(makeUser() as any);
      const draft = await service.getActiveDraft("user-1");
      await service.handleWizardText(makeUser() as any, draft!.id, "5k");
      expect(Number(prisma._drafts.get(draft!.id)!.amount)).toBe(5000);
    });

    it("offers saved beneficiaries when starting a send with no payee", async () => {
      tagging.listRecipientsForUser.mockResolvedValue([
        {
          id: "r1",
          nickname: "James",
          accountNumber: "1111222233",
          label: RecipientLabel.FOOD,
        },
      ]);
      await service.startTransferWizard(makeUser() as any, { amount: 5000 });
      expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("who are you sending to"),
        "Pick recipient",
        expect.arrayContaining([
          expect.objectContaining({ id: "beneficiary:r1" }),
        ]),
        "user-1",
      );
      expect(await service.getActiveDraft("user-1")).toBeNull();
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

    it("applyHintsToDraft merges mid-flow without restarting", async () => {
      await service.startTransferWizard(makeUser() as any, {
        accountNumber: "8100368023",
        bankCode: "000013",
        bankName: "Opay",
      });
      const draftBefore = await service.getActiveDraft("user-1");
      expect(draftBefore!.step).toBe(TransferDraftStep.AWAITING_AMOUNT);

      rubies.nameEnquiry.mockResolvedValue({
        accountName: "Jane Doe",
        bankName: "Opay",
      });
      await service.applyHintsToDraft(makeUser() as any, { amount: 800 });

      const draftAfter = await service.getActiveDraft("user-1");
      expect(draftAfter!.id).toBe(draftBefore!.id);
      expect(Number(draftAfter!.amount)).toBe(800);
      expect(rubies.nameEnquiry).toHaveBeenCalled();
    });

    it("applyHintsToDraft is a no-op when no draft is open", async () => {
      await service.applyHintsToDraft(makeUser() as any, { amount: 800 });
      expect(await service.getActiveDraft("user-1")).toBeNull();
      expect(whatsapp.sendText).not.toHaveBeenCalled();
    });

    it("cancelActiveSurfaces silently cancels the draft and pending confirms", async () => {
      await service.startTransferWizard(makeUser() as any);
      const draft = await service.getActiveDraft("user-1");
      whatsapp.sendText.mockClear();

      await service.cancelActiveSurfaces(makeUser() as any);

      expect(prisma._drafts.get(draft!.id)!.status).toBe(
        TransferDraftStatus.CANCELLED,
      );
      expect(transferConfirmation.cancelPendingForUser).toHaveBeenCalledWith(
        "user-1",
        { silent: true },
      );
      expect(whatsapp.sendText).not.toHaveBeenCalledWith(
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
          purposeLabel: RecipientLabel.OTHER,
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
          purposeLabel: RecipientLabel.RENT,
        }),
      );
      expect(prisma._drafts.get(draftId)!.status).toBe(
        TransferDraftStatus.COMPLETED,
      );
    });

    it("asks for a typed purpose after Other, then finalizes", async () => {
      rubies.nameEnquiry.mockResolvedValue({
        accountName: "Jane Doe",
        bankName: "GTBank",
      });
      const draftId = await driveToBankStep();
      await service.handleWizardText(makeUser() as any, draftId, "gtbank");
      await service.handleWizardSelection(
        makeUser() as any,
        draftId,
        "label:OTHER",
      );
      expect(prisma._drafts.get(draftId)!.step).toBe(
        TransferDraftStep.AWAITING_PURPOSE_NOTE,
      );
      expect(transferConfirmation.initiateTransfer).not.toHaveBeenCalled();

      await service.handleWizardText(makeUser() as any, draftId, "school fees");
      expect(transferConfirmation.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          purposeLabel: RecipientLabel.OTHER,
          purposeNote: "school fees",
          label: RecipientLabel.OTHER,
        }),
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

  describe("beneficiary prefill", () => {
    it("prefills account and bank from a unique saved beneficiary", async () => {
      tagging.matchBeneficiaryByName.mockResolvedValue({
        id: "r-james",
        accountNumber: "9988776655",
        bankCode: "000013",
        nickname: "james",
        label: RecipientLabel.VENDOR,
      });
      tagging.findRecipient.mockResolvedValue({
        id: "r-james",
        label: RecipientLabel.VENDOR,
      });
      rubies.nameEnquiry.mockResolvedValue({
        accountName: "James Okonkwo",
        bankName: "GTBank",
      });

      await service.startTransferWizard(makeUser() as any, {
        amount: 5000,
        beneficiaryName: "james",
        labelHint: RecipientLabel.FOOD,
      });

      expect(transferConfirmation.initiateTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          accountNumber: "9988776655",
          bankCode: "000013",
          amount: 5000,
          label: RecipientLabel.VENDOR,
          purposeLabel: RecipientLabel.FOOD,
          beneficiaryNickname: "james",
        }),
      );
    });

    it("sends a disambiguation list when multiple beneficiaries match", async () => {
      tagging.matchBeneficiaryByName.mockResolvedValue(null);
      tagging.findAmbiguousBeneficiaryMatches.mockResolvedValue([
        {
          id: "r1",
          nickname: "James",
          accountNumber: "111",
          label: RecipientLabel.FOOD,
        },
        {
          id: "r2",
          nickname: "James",
          accountNumber: "222",
          label: RecipientLabel.VENDOR,
        },
      ]);

      await service.startTransferWizard(makeUser() as any, {
        amount: 5000,
        beneficiaryName: "james",
      });

      expect(whatsapp.sendListMessage).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("which james"),
        "Pick recipient",
        expect.arrayContaining([
          expect.objectContaining({ id: "beneficiary:r1" }),
          expect.objectContaining({ id: "beneficiary:r2" }),
        ]),
        "user-1",
      );
      expect(transferConfirmation.initiateTransfer).not.toHaveBeenCalled();
    });

    it("does not invent an account for an unknown beneficiary name", async () => {
      tagging.matchBeneficiaryByName.mockResolvedValue(null);
      await service.startTransferWizard(makeUser() as any, {
        amount: 5000,
        beneficiaryName: "zyxnotaperson",
      });
      const draft = await service.getActiveDraft("user-1");
      expect(draft?.accountNumber).toBeNull();
      expect(whatsapp.sendText).toHaveBeenCalledWith(
        "234801",
        expect.stringContaining("account number"),
        "user-1",
      );
    });
  });
});
