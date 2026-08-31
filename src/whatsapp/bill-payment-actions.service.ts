import { Injectable, Logger } from "@nestjs/common";
import {
  BillPaymentCategory,
  BillPaymentDraftStatus,
  BillPaymentDraftStep,
  TransferDraftStatus,
  User,
} from "@prisma/client";
import { parseNairaAmount } from "../common/naira-amount.util";
import { TransferWizardHints } from "../orchestrator/transfer-hints.util";
import { PrismaService } from "../prisma/prisma.service";
import { RubiesService } from "../rubies/rubies.service";
import { WhatsappService } from "./whatsapp.service";
import { BillPaymentConfirmationService } from "./bill-payment-confirmation.service";
import { TransferConfirmationService } from "./transfer-confirmation.service";
import {
  bundlesForTelco,
  DATA_TELCOS,
  ELECTRICITY_DISCOS,
  findDataBundle,
  findDataTelco,
  findElectricityDisco,
  formatBundleListTitle,
  matchDataTelcoHint,
  matchElectricityDiscoHint,
  normalizeMeterNumber,
} from "./bill-payment-catalog";
import {
  AIRTIME_TELCOS,
  BILL_CANCEL_WORDS,
  BUNDLE_BUTTON_PREFIX,
  DATA_TELCO_BUTTON_PREFIX,
  DISCO_BUTTON_PREFIX,
  findAirtimeTelco,
  matchAirtimeTelcoHint,
  MAX_AIRTIME_AMOUNT,
  MIN_AIRTIME_AMOUNT,
  normalizeMsisdn,
  TELCO_BUTTON_PREFIX,
} from "./bill-payment.constants";

@Injectable()
export class BillPaymentActionsService {
  private readonly logger = new Logger(BillPaymentActionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rubies: RubiesService,
    private readonly whatsapp: WhatsappService,
    private readonly billConfirmation: BillPaymentConfirmationService,
    private readonly transferConfirmation: TransferConfirmationService,
  ) {}

  async getActiveDraft(userId: string) {
    return this.prisma.billPaymentDraft.findFirst({
      where: { userId, status: BillPaymentDraftStatus.ACTIVE },
      orderBy: { createdAt: "desc" },
    });
  }

  async startAirtimeWizard(
    user: User,
    hints?: TransferWizardHints,
  ): Promise<void> {
    if (!(await this.ensureAccount(user, "airtime"))) return;

    await this.prepareNewDraft(user, BillPaymentCategory.AIRTIME, {
      step: BillPaymentDraftStep.AWAITING_TELCO,
    });
    await this.applyHintsToDraft(user, hints ?? {});
  }

  async startDataWizard(
    user: User,
    hints?: TransferWizardHints,
  ): Promise<void> {
    if (!(await this.ensureAccount(user, "data"))) return;

    await this.prepareNewDraft(user, BillPaymentCategory.DATA, {
      step: BillPaymentDraftStep.AWAITING_TELCO,
    });
    await this.applyHintsToDraft(user, hints ?? {});
  }

  async startElectricityWizard(
    user: User,
    hints?: TransferWizardHints,
  ): Promise<void> {
    if (!(await this.ensureAccount(user, "electricity"))) return;

    await this.prepareNewDraft(user, BillPaymentCategory.ELECTRICITY, {
      step: BillPaymentDraftStep.AWAITING_DISCO,
    });
    await this.applyHintsToDraft(user, hints ?? {});
  }

  async applyHintsToDraft(
    user: User,
    hints: TransferWizardHints,
  ): Promise<void> {
    const draft = await this.getActiveDraft(user.id);
    if (!draft) return;

    if (draft.category === BillPaymentCategory.AIRTIME) {
      await this.advanceAirtimeWithHints(user, draft.id, hints);
      return;
    }
    if (draft.category === BillPaymentCategory.DATA) {
      await this.advanceDataWithHints(user, draft.id, hints);
      return;
    }
    if (draft.category === BillPaymentCategory.ELECTRICITY) {
      await this.advanceElectricityWithHints(user, draft.id, hints);
    }
  }

  async handleAirtimeTelcoSelection(
    user: User,
    draftId: string,
    billerCode: string,
  ): Promise<void> {
    const telco = findAirtimeTelco(billerCode);
    if (!telco) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that network isn't available, pick one from the list.",
        user.id,
      );
      return;
    }

    const draft = await this.requireActiveDraft(user, draftId, "airtime");
    if (!draft) return;

    await this.prisma.billPaymentDraft.update({
      where: { id: draft.id },
      data: {
        billerCode: telco.billerCode,
        productCode: telco.productCode,
        telcoLabel: telco.label,
        step: BillPaymentDraftStep.AWAITING_AMOUNT,
      },
    });

    await this.advanceAirtimeWithHints(user, draft.id, {});
  }

  async handleDataTelcoSelection(
    user: User,
    draftId: string,
    billerCode: string,
  ): Promise<void> {
    const telco = findDataTelco(billerCode);
    if (!telco) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that network isn't available, pick one from the list.",
        user.id,
      );
      return;
    }

    const draft = await this.requireActiveDraft(user, draftId, "data");
    if (!draft) return;

    const bundles = bundlesForTelco(telco.billerCode);
    if (bundles.length === 0) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "no data bundles are available for that network right now.",
        user.id,
      );
      return;
    }

    await this.prisma.billPaymentDraft.update({
      where: { id: draft.id },
      data: {
        billerCode: telco.billerCode,
        telcoLabel: telco.label,
        step: BillPaymentDraftStep.AWAITING_PRODUCT,
      },
    });

    await this.whatsapp.sendListMessage(
      user.whatsappNumber,
      `pick a ${telco.label} data plan`,
      "Pick plan",
      bundles.map((b) => ({
        id: `${BUNDLE_BUTTON_PREFIX}${telco.billerCode}:${b.productCode}`,
        title: formatBundleListTitle(b),
        description: b.label,
      })),
      user.id,
    );
  }

  async handleBundleSelection(
    user: User,
    draftId: string,
    billerCode: string,
    productCode: string,
  ): Promise<void> {
    const bundle = findDataBundle(billerCode, productCode);
    if (!bundle) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that plan isn't available, pick one from the list.",
        user.id,
      );
      return;
    }

    const draft = await this.requireActiveDraft(user, draftId, "data");
    if (!draft) return;

    await this.prisma.billPaymentDraft.update({
      where: { id: draft.id },
      data: {
        billerCode,
        productCode: bundle.productCode,
        productLabel: bundle.label,
        amount: bundle.amount,
        step: BillPaymentDraftStep.AWAITING_MSISDN,
      },
    });

    await this.advanceDataWithHints(user, draft.id, {});
  }

  async handleDiscoSelection(
    user: User,
    draftId: string,
    billerCode: string,
  ): Promise<void> {
    const disco = findElectricityDisco(billerCode);
    if (!disco) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that provider isn't available, pick one from the list.",
        user.id,
      );
      return;
    }

    const draft = await this.requireActiveDraft(user, draftId, "electricity");
    if (!draft) return;

    await this.prisma.billPaymentDraft.update({
      where: { id: draft.id },
      data: {
        billerCode: disco.billerCode,
        productCode: disco.productCode,
        telcoLabel: disco.label,
        step: BillPaymentDraftStep.AWAITING_METER,
      },
    });

    await this.advanceElectricityWithHints(user, draft.id, {});
  }

  async handleWizardText(
    user: User,
    draftId: string,
    text: string,
  ): Promise<void> {
    if (BILL_CANCEL_WORDS.test(text.trim())) {
      await this.cancelDraft(user, draftId);
      return;
    }

    const draft = await this.requireActiveDraft(user, draftId);
    if (!draft) return;

    if (draft.category === BillPaymentCategory.AIRTIME) {
      await this.handleAirtimeWizardText(user, draft, text);
      return;
    }

    if (draft.category === BillPaymentCategory.DATA) {
      await this.handleDataWizardText(user, draft, text);
      return;
    }

    if (draft.category === BillPaymentCategory.ELECTRICITY) {
      await this.handleElectricityWizardText(user, draft, text);
    }
  }

  async cancelDraft(
    user: User,
    draftId: string,
    options?: { silent?: boolean },
  ): Promise<void> {
    const draft = await this.prisma.billPaymentDraft.findFirst({
      where: {
        id: draftId,
        userId: user.id,
        status: BillPaymentDraftStatus.ACTIVE,
      },
    });
    if (!draft) return;

    await this.prisma.billPaymentDraft.update({
      where: { id: draftId },
      data: { status: BillPaymentDraftStatus.CANCELLED },
    });

    if (!options?.silent) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        cancelMessageForCategory(draft.category),
        user.id,
      );
    }
  }

  async cancelActiveDraftForUser(
    userId: string,
    options?: { silent?: boolean },
  ): Promise<void> {
    const draft = await this.getActiveDraft(userId);
    if (!draft) return;
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });
    await this.cancelDraft(user, draft.id, options);
  }

  private async handleAirtimeWizardText(
    user: User,
    draft: { id: string; step: BillPaymentDraftStep },
    text: string,
  ): Promise<void> {
    if (draft.step === BillPaymentDraftStep.AWAITING_AMOUNT) {
      const amount = this.clampBillAmount(parseNairaAmount(text));
      if (amount == null) {
        await this.whatsapp.sendText(
          user.whatsappNumber,
          `that didn't read as an amount between ₦${MIN_AIRTIME_AMOUNT} and ₦${MAX_AIRTIME_AMOUNT.toLocaleString("en-NG")}. how much airtime?`,
          user.id,
        );
        return;
      }

      await this.prisma.billPaymentDraft.update({
        where: { id: draft.id },
        data: {
          amount,
          step: BillPaymentDraftStep.AWAITING_MSISDN,
        },
      });
      await this.advanceAirtimeWithHints(user, draft.id, {});
      return;
    }

    if (draft.step === BillPaymentDraftStep.AWAITING_MSISDN) {
      const msisdn = normalizeMsisdn(text);
      if (!msisdn) {
        await this.whatsapp.sendText(
          user.whatsappNumber,
          "that doesn't look like a valid nigerian phone number, try again.",
          user.id,
        );
        return;
      }

      const updated = await this.finalizeDraft(user, draft.id, { msisdn });
      if (!updated) return;

      await this.billConfirmation.initiateBillPayment({
        userId: user.id,
        category: BillPaymentCategory.AIRTIME,
        billerCode: updated.billerCode!,
        productCode: updated.productCode!,
        telcoLabel: updated.telcoLabel!,
        msisdn,
        amount: Number(updated.amount),
      });
    }
  }

  private async handleDataWizardText(
    user: User,
    draft: { id: string; step: BillPaymentDraftStep },
    text: string,
  ): Promise<void> {
    if (draft.step !== BillPaymentDraftStep.AWAITING_MSISDN) return;

    const msisdn = normalizeMsisdn(text);
    if (!msisdn) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "that doesn't look like a valid nigerian phone number, try again.",
        user.id,
      );
      return;
    }

    const updated = await this.finalizeDraft(user, draft.id, { msisdn });
    if (!updated) return;

    await this.billConfirmation.initiateBillPayment({
      userId: user.id,
      category: BillPaymentCategory.DATA,
      billerCode: updated.billerCode!,
      productCode: updated.productCode!,
      telcoLabel: updated.telcoLabel!,
      productLabel: updated.productLabel ?? undefined,
      msisdn,
      amount: Number(updated.amount),
    });
  }

  private async handleElectricityWizardText(
    user: User,
    draft: { id: string; step: BillPaymentDraftStep },
    text: string,
  ): Promise<void> {
    if (draft.step === BillPaymentDraftStep.AWAITING_METER) {
      const meter = normalizeMeterNumber(text);
      if (!meter) {
        await this.whatsapp.sendText(
          user.whatsappNumber,
          "that doesn't look like a valid meter number, try again.",
          user.id,
        );
        return;
      }

      const current = await this.prisma.billPaymentDraft.findUniqueOrThrow({
        where: { id: draft.id },
      });
      if (!current.billerCode || !current.productCode) {
        this.logger.error(
          `Electricity draft ${draft.id} missing biller/product`,
        );
        return;
      }

      const lookup = await this.rubies.validateVasCustomer({
        billerCode: current.billerCode,
        productCode: current.productCode,
        billerCustomerId: meter,
      });

      if (!lookup.ok || !lookup.customerName) {
        await this.whatsapp.sendText(
          user.whatsappNumber,
          "couldn't verify that meter number for this provider, check it and try again.",
          user.id,
        );
        return;
      }

      await this.prisma.billPaymentDraft.update({
        where: { id: draft.id },
        data: {
          msisdn: meter,
          customerName: lookup.customerName,
          step: BillPaymentDraftStep.AWAITING_AMOUNT,
        },
      });

      await this.whatsapp.sendText(
        user.whatsappNumber,
        `meter verified: ${lookup.customerName}.\nhow much prepaid electricity?`,
        user.id,
      );
      return;
    }

    if (draft.step === BillPaymentDraftStep.AWAITING_AMOUNT) {
      const amount = this.clampBillAmount(parseNairaAmount(text));
      if (amount == null) {
        await this.whatsapp.sendText(
          user.whatsappNumber,
          `that didn't read as an amount between ₦${MIN_AIRTIME_AMOUNT} and ₦${MAX_AIRTIME_AMOUNT.toLocaleString("en-NG")}. how much prepaid electricity?`,
          user.id,
        );
        return;
      }

      const updated = await this.finalizeDraft(user, draft.id, { amount });
      if (!updated) return;

      await this.billConfirmation.initiateBillPayment({
        userId: user.id,
        category: BillPaymentCategory.ELECTRICITY,
        billerCode: updated.billerCode!,
        productCode: updated.productCode!,
        telcoLabel: updated.telcoLabel!,
        productLabel: "Prepaid electricity",
        msisdn: updated.msisdn!,
        customerName: updated.customerName ?? undefined,
        amount: Number(updated.amount),
      });
    }
  }

  private clampBillAmount(amount: number | null): number | null {
    if (amount == null) return null;
    if (amount < MIN_AIRTIME_AMOUNT || amount > MAX_AIRTIME_AMOUNT) return null;
    return amount;
  }

  private async advanceAirtimeWithHints(
    user: User,
    draftId: string,
    hints: TransferWizardHints,
  ): Promise<void> {
    const current = await this.prisma.billPaymentDraft.findUniqueOrThrow({
      where: { id: draftId },
    });
    const telco =
      matchAirtimeTelcoHint(hints.telcoHint) ??
      (current.billerCode ? findAirtimeTelco(current.billerCode) : undefined);

    let draft = await this.prisma.billPaymentDraft.findUniqueOrThrow({
      where: { id: draftId },
    });

    const hintedAmount = this.clampBillAmount(hints.amount ?? null);
    const hintedMsisdn = hints.msisdn ? normalizeMsisdn(hints.msisdn) : null;
    if (hintedAmount != null || hintedMsisdn) {
      draft = await this.prisma.billPaymentDraft.update({
        where: { id: draftId },
        data: {
          ...(hintedAmount != null ? { amount: hintedAmount } : {}),
          ...(hintedMsisdn ? { msisdn: hintedMsisdn } : {}),
        },
      });
    }

    if (!draft.billerCode && telco) {
      draft = await this.prisma.billPaymentDraft.update({
        where: { id: draftId },
        data: {
          billerCode: telco.billerCode,
          productCode: telco.productCode,
          telcoLabel: telco.label,
          step: BillPaymentDraftStep.AWAITING_AMOUNT,
        },
      });
    }

    if (!draft.billerCode) {
      await this.whatsapp.sendListMessage(
        user.whatsappNumber,
        "which network?",
        "Pick network",
        AIRTIME_TELCOS.map((t) => ({
          id: `${TELCO_BUTTON_PREFIX}${t.billerCode}`,
          title: t.label,
          description: "Airtime",
        })),
        user.id,
      );
      return;
    }

    const amount =
      this.clampBillAmount(hints.amount ?? null) ??
      (draft.amount != null ? Number(draft.amount) : null);
    if (amount != null && draft.amount == null) {
      draft = await this.prisma.billPaymentDraft.update({
        where: { id: draftId },
        data: { amount, step: BillPaymentDraftStep.AWAITING_MSISDN },
      });
    } else if (
      amount != null &&
      draft.step === BillPaymentDraftStep.AWAITING_AMOUNT
    ) {
      draft = await this.prisma.billPaymentDraft.update({
        where: { id: draftId },
        data: { amount, step: BillPaymentDraftStep.AWAITING_MSISDN },
      });
    }

    if (draft.amount == null) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `how much ${draft.telcoLabel ?? ""} airtime?`.replace(/\s+/g, " "),
        user.id,
      );
      return;
    }

    const msisdn =
      (hints.msisdn ? normalizeMsisdn(hints.msisdn) : null) ??
      (draft.msisdn ? normalizeMsisdn(draft.msisdn) : null);
    if (msisdn) {
      const updated = await this.finalizeDraft(user, draftId, { msisdn });
      if (!updated) return;
      await this.billConfirmation.initiateBillPayment({
        userId: user.id,
        category: BillPaymentCategory.AIRTIME,
        billerCode: updated.billerCode!,
        productCode: updated.productCode!,
        telcoLabel: updated.telcoLabel!,
        msisdn,
        amount: Number(updated.amount),
      });
      return;
    }

    if (
      draft.step === BillPaymentDraftStep.AWAITING_MSISDN ||
      draft.amount != null
    ) {
      await this.prisma.billPaymentDraft.update({
        where: { id: draftId },
        data: { step: BillPaymentDraftStep.AWAITING_MSISDN },
      });
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "which phone number should receive the airtime?",
        user.id,
      );
    }
  }

  private async advanceDataWithHints(
    user: User,
    draftId: string,
    hints: TransferWizardHints,
  ): Promise<void> {
    const current = await this.prisma.billPaymentDraft.findUniqueOrThrow({
      where: { id: draftId },
    });
    const telco =
      matchDataTelcoHint(hints.telcoHint) ??
      (current.billerCode ? findDataTelco(current.billerCode) : undefined);

    let draft = await this.prisma.billPaymentDraft.findUniqueOrThrow({
      where: { id: draftId },
    });

    const hintedMsisdn = hints.msisdn ? normalizeMsisdn(hints.msisdn) : null;
    if (hintedMsisdn) {
      draft = await this.prisma.billPaymentDraft.update({
        where: { id: draftId },
        data: { msisdn: hintedMsisdn },
      });
    }

    if (!draft.billerCode && telco) {
      draft = await this.prisma.billPaymentDraft.update({
        where: { id: draftId },
        data: {
          billerCode: telco.billerCode,
          telcoLabel: telco.label,
          step: BillPaymentDraftStep.AWAITING_PRODUCT,
        },
      });
    }

    if (!draft.billerCode) {
      await this.whatsapp.sendListMessage(
        user.whatsappNumber,
        "which network for data?",
        "Pick network",
        DATA_TELCOS.map((t) => ({
          id: `${DATA_TELCO_BUTTON_PREFIX}${t.billerCode}`,
          title: t.label,
          description: "Data bundle",
        })),
        user.id,
      );
      return;
    }

    if (!draft.productCode) {
      const bundles = bundlesForTelco(draft.billerCode);
      if (bundles.length === 0) {
        await this.whatsapp.sendText(
          user.whatsappNumber,
          "no data bundles are available for that network right now.",
          user.id,
        );
        return;
      }
      await this.prisma.billPaymentDraft.update({
        where: { id: draftId },
        data: { step: BillPaymentDraftStep.AWAITING_PRODUCT },
      });
      await this.whatsapp.sendListMessage(
        user.whatsappNumber,
        `pick a ${draft.telcoLabel} data plan`,
        "Pick plan",
        bundles.map((b) => ({
          id: `${BUNDLE_BUTTON_PREFIX}${draft.billerCode}:${b.productCode}`,
          title: formatBundleListTitle(b),
          description: b.label,
        })),
        user.id,
      );
      return;
    }

    const msisdn =
      (hints.msisdn ? normalizeMsisdn(hints.msisdn) : null) ??
      (draft.msisdn ? normalizeMsisdn(draft.msisdn) : null);
    if (msisdn) {
      const updated = await this.finalizeDraft(user, draftId, { msisdn });
      if (!updated) return;
      await this.billConfirmation.initiateBillPayment({
        userId: user.id,
        category: BillPaymentCategory.DATA,
        billerCode: updated.billerCode!,
        productCode: updated.productCode!,
        telcoLabel: updated.telcoLabel!,
        productLabel: updated.productLabel ?? undefined,
        msisdn,
        amount: Number(updated.amount),
      });
      return;
    }

    await this.prisma.billPaymentDraft.update({
      where: { id: draftId },
      data: { step: BillPaymentDraftStep.AWAITING_MSISDN },
    });
    await this.whatsapp.sendText(
      user.whatsappNumber,
      "which phone number should receive the data?",
      user.id,
    );
  }

  private async advanceElectricityWithHints(
    user: User,
    draftId: string,
    hints: TransferWizardHints,
  ): Promise<void> {
    const current = await this.prisma.billPaymentDraft.findUniqueOrThrow({
      where: { id: draftId },
    });
    const disco =
      matchElectricityDiscoHint(hints.discoHint) ??
      (current.billerCode
        ? findElectricityDisco(current.billerCode)
        : undefined);

    let draft = await this.prisma.billPaymentDraft.findUniqueOrThrow({
      where: { id: draftId },
    });

    if (!draft.billerCode && disco) {
      draft = await this.prisma.billPaymentDraft.update({
        where: { id: draftId },
        data: {
          billerCode: disco.billerCode,
          productCode: disco.productCode,
          telcoLabel: disco.label,
          step: BillPaymentDraftStep.AWAITING_METER,
        },
      });
    }

    if (!draft.billerCode) {
      await this.whatsapp.sendListMessage(
        user.whatsappNumber,
        "which electricity provider?",
        "Pick provider",
        ELECTRICITY_DISCOS.map((d) => ({
          id: `${DISCO_BUTTON_PREFIX}${d.billerCode}`,
          title: d.label.slice(0, 24),
          description: "Prepaid meter",
        })),
        user.id,
      );
      return;
    }

    const meter = hints.meter
      ? normalizeMeterNumber(hints.meter)
      : draft.msisdn
        ? normalizeMeterNumber(draft.msisdn)
        : null;

    if (!draft.msisdn && !meter) {
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "what's your prepaid meter number?",
        user.id,
      );
      return;
    }

    if (!draft.customerName && meter) {
      await this.handleElectricityWizardText(user, draft, meter);
      const after = await this.prisma.billPaymentDraft.findUnique({
        where: { id: draftId },
      });
      if (!after || after.status !== BillPaymentDraftStatus.ACTIVE) return;
      draft = after;
      const amount = this.clampBillAmount(hints.amount ?? null);
      if (
        amount != null &&
        after.step === BillPaymentDraftStep.AWAITING_AMOUNT
      ) {
        const updated = await this.finalizeDraft(user, draftId, { amount });
        if (!updated) return;
        await this.billConfirmation.initiateBillPayment({
          userId: user.id,
          category: BillPaymentCategory.ELECTRICITY,
          billerCode: updated.billerCode!,
          productCode: updated.productCode!,
          telcoLabel: updated.telcoLabel!,
          productLabel: "Prepaid electricity",
          msisdn: updated.msisdn!,
          customerName: updated.customerName ?? undefined,
          amount: Number(updated.amount),
        });
      }
      return;
    }

    const amount = this.clampBillAmount(hints.amount ?? null);
    if (amount != null && draft.msisdn && draft.customerName) {
      const updated = await this.finalizeDraft(user, draftId, { amount });
      if (!updated) return;
      await this.billConfirmation.initiateBillPayment({
        userId: user.id,
        category: BillPaymentCategory.ELECTRICITY,
        billerCode: updated.billerCode!,
        productCode: updated.productCode!,
        telcoLabel: updated.telcoLabel!,
        productLabel: "Prepaid electricity",
        msisdn: updated.msisdn!,
        customerName: updated.customerName ?? undefined,
        amount: Number(updated.amount),
      });
      return;
    }

    await this.whatsapp.sendText(
      user.whatsappNumber,
      `meter verified: ${draft.customerName}.\nhow much prepaid electricity?`,
      user.id,
    );
  }

  private async finalizeDraft(
    user: User,
    draftId: string,
    data: { msisdn?: string; amount?: number },
  ) {
    const updated = await this.prisma.billPaymentDraft.update({
      where: { id: draftId },
      data: {
        ...data,
        status: BillPaymentDraftStatus.COMPLETED,
      },
    });

    if (
      !updated.billerCode ||
      !updated.productCode ||
      !updated.telcoLabel ||
      !updated.amount ||
      !updated.msisdn
    ) {
      this.logger.error(`Bill draft ${draftId} incomplete at finalize`);
      await this.whatsapp.sendText(
        user.whatsappNumber,
        "something went wrong finishing that request, please start again.",
        user.id,
      );
      return null;
    }

    return updated;
  }

  private async prepareNewDraft(
    user: User,
    category: BillPaymentCategory,
    data: { step: BillPaymentDraftStep },
  ) {
    await this.transferConfirmation.cancelPendingForUser(user.id, {
      silent: true,
    });
    await this.billConfirmation.cancelPendingForUser(user.id, { silent: true });

    await this.prisma.transferDraft.updateMany({
      where: { userId: user.id, status: TransferDraftStatus.ACTIVE },
      data: { status: TransferDraftStatus.CANCELLED },
    });

    await this.prisma.billPaymentDraft.updateMany({
      where: { userId: user.id, status: BillPaymentDraftStatus.ACTIVE },
      data: { status: BillPaymentDraftStatus.CANCELLED },
    });

    return this.prisma.billPaymentDraft.create({
      data: {
        userId: user.id,
        category,
        step: data.step,
        status: BillPaymentDraftStatus.ACTIVE,
      },
    });
  }

  private async ensureAccount(user: User, product: string): Promise<boolean> {
    if (user.rubiesAccountNumber) return true;
    await this.whatsapp.sendText(
      user.whatsappNumber,
      `you don't have a udara account yet, so there's nothing to buy ${product} from.`,
      user.id,
    );
    return false;
  }

  private async requireActiveDraft(
    user: User,
    draftId: string,
    productHint?: "airtime" | "data" | "electricity",
  ) {
    const draft = await this.prisma.billPaymentDraft.findFirst({
      where: {
        id: draftId,
        userId: user.id,
        status: BillPaymentDraftStatus.ACTIVE,
      },
    });
    if (!draft) {
      const hint = productHint ?? "airtime";
      await this.whatsapp.sendText(
        user.whatsappNumber,
        `that request has expired, say "${hint}" to start again.`,
        user.id,
      );
      return null;
    }
    return draft;
  }
}

function cancelMessageForCategory(category: BillPaymentCategory): string {
  switch (category) {
    case BillPaymentCategory.DATA:
      return "cancelled, no data was bought.";
    case BillPaymentCategory.ELECTRICITY:
      return "cancelled, no electricity was bought.";
    default:
      return "cancelled, no airtime was bought.";
  }
}
