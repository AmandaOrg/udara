import {
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from "@nestjs/common";
import {
  SavingsBucketType,
  SavingsMovementDirection,
  SavingsMovementStatus,
  SavingsPlanStatus,
} from "@prisma/client";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../../prisma/prisma.service";
import { RubiesService } from "../../rubies/rubies.service";
import { PinService } from "../../pin/pin.service";
import { CreatePlanDto, QuickSaveDto, UpdatePlanDto, WithdrawDto } from "./savings.dto";
import {
  fromSlug,
  SavingsActionResultView,
  SavingsActivityDetailView,
  SavingsActivityView,
  SavingsBucketDetailView,
  SavingsBucketView,
  SavingsOverviewView,
  SavingsPlanView,
  toSlug,
} from "./savings.view";

const BUCKET_METADATA: Record<
  SavingsBucketType,
  { title: string; subtitle: string; color: string; icon: string }
> = {
  [SavingsBucketType.SPEND_SAVE]: {
    title: "Spend & Save",
    subtitle: "Save a cut of every spend",
    color: "#7A2E35",
    icon: "swap-horizontal-outline",
  },
  [SavingsBucketType.AUTO_SAVE]: {
    title: "Auto Save",
    subtitle: "Scheduled transfers on autopilot",
    color: "#2A7D62",
    icon: "flash-outline",
  },
  [SavingsBucketType.HARDLOCK]: {
    title: "HardLock",
    subtitle: "Locked funds you can’t touch early",
    color: "#4568A6",
    icon: "lock-closed-outline",
  },
  [SavingsBucketType.GOAL_BASED]: {
    title: "Money pots",
    subtitle: "Separate pots for what you’re saving for",
    color: "#9A6B35",
    icon: "flag-outline",
  },
};

function formatWhen(date: Date): string {
  const now = new Date();
  const diffDays = Math.round((now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

@Injectable()
export class SavingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rubies: RubiesService,
    private readonly pinService: PinService,
  ) {}

  /** Ensures all 4 canonical buckets exist for the user. */
  async ensureBuckets(userId: string) {
    const existing = await this.prisma.savingsBucket.findMany({
      where: { userId },
      select: { type: true },
    });
    const existingTypes = new Set(existing.map((b) => b.type));
    const allTypes = [
      SavingsBucketType.SPEND_SAVE,
      SavingsBucketType.AUTO_SAVE,
      SavingsBucketType.HARDLOCK,
      SavingsBucketType.GOAL_BASED,
    ];

    const missing = allTypes.filter((t) => !existingTypes.has(t));
    if (missing.length > 0) {
      await this.prisma.savingsBucket.createMany({
        data: missing.map((type) => ({
          userId,
          type,
          balance: 0,
        })),
        skipDuplicates: true,
      });
    }
  }

  async getOverview(userId: string): Promise<SavingsOverviewView> {
    await this.ensureBuckets(userId);

    const [buckets, recentTxns] = await Promise.all([
      this.prisma.savingsBucket.findMany({
        where: { userId },
        include: {
          plans: {
            where: {
              status: { in: [SavingsPlanStatus.ACTIVE, SavingsPlanStatus.LOCKED] },
            },
            select: { id: true },
          },
        },
        orderBy: { createdAt: "asc" },
      }),
      this.prisma.savingsTransaction.findMany({
        where: { userId },
        orderBy: { occurredAt: "desc" },
        take: 10,
        include: { bucket: true },
      }),
    ]);

    let totalSavings = 0;
    const bucketViews: SavingsBucketView[] = buckets.map((b) => {
      const balanceNum = Number(b.balance);
      totalSavings += balanceNum;
      const meta = BUCKET_METADATA[b.type];
      return {
        id: toSlug(b.type),
        type: b.type,
        title: meta.title,
        subtitle: meta.subtitle,
        amount: balanceNum,
        color: meta.color,
        icon: meta.icon,
        items: [],
        activePlansCount: b.plans.length,
      };
    });

    const recentSaves: SavingsActivityView[] = recentTxns.map((t) => ({
      id: t.id,
      label: t.label,
      amount: Number(t.amount),
      when: formatWhen(t.occurredAt),
      occurredAt: t.occurredAt.toISOString(),
      status: t.status === SavingsMovementStatus.SUCCESSFUL ? "successful" : t.status === SavingsMovementStatus.PENDING ? "pending" : "failed",
      direction: t.direction === SavingsMovementDirection.IN ? "in" : "out",
      bucketId: toSlug(t.bucket.type),
      category: t.category,
      planId: t.planId,
    }));

    return {
      totalSavings,
      buckets: bucketViews,
      recentSaves,
    };
  }

  async getBucketDetail(
    userId: string,
    bucketTypeOrSlug: string,
  ): Promise<SavingsBucketDetailView> {
    await this.ensureBuckets(userId);
    const type = fromSlug(bucketTypeOrSlug);

    const bucket = await this.prisma.savingsBucket.findUniqueOrThrow({
      where: {
        userId_type: {
          userId,
          type,
        },
      },
      include: {
        plans: {
          orderBy: { createdAt: "desc" },
        },
        transactions: {
          orderBy: { occurredAt: "desc" },
          take: 20,
        },
      },
    });

    const meta = BUCKET_METADATA[bucket.type];
    const bucketView: SavingsBucketView = {
      id: toSlug(bucket.type),
      type: bucket.type,
      title: meta.title,
      subtitle: meta.subtitle,
      amount: Number(bucket.balance),
      color: meta.color,
      icon: meta.icon,
      items: [],
      activePlansCount: bucket.plans.filter(
        (p) => p.status === SavingsPlanStatus.ACTIVE || p.status === SavingsPlanStatus.LOCKED,
      ).length,
    };

    const ongoingPlans: SavingsPlanView[] = [];
    const finishedPlans: SavingsPlanView[] = [];

    for (const plan of bucket.plans) {
      const planView: SavingsPlanView = {
        id: plan.id,
        title: plan.title,
        emoji: plan.emoji,
        color: plan.color,
        colorBg: plan.colorBg,
        amount: Number(plan.currentAmount),
        targetAmount: plan.targetAmount ? Number(plan.targetAmount) : null,
        rateLabel: plan.rateLabel,
        unlockLabel: plan.unlockDate
          ? `Unlocks ${plan.unlockDate.toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`
          : null,
        status: plan.status,
        meta: plan.targetAmount
          ? `of ₦${Number(plan.targetAmount).toLocaleString("en-NG")}`
          : plan.rateLabel ?? undefined,
        cadence: plan.cadence ?? undefined,
        createdAt: plan.createdAt.toISOString(),
      };

      if (plan.status === SavingsPlanStatus.ACTIVE || plan.status === SavingsPlanStatus.LOCKED) {
        ongoingPlans.push(planView);
      } else {
        finishedPlans.push(planView);
      }
    }

    const activity: SavingsActivityView[] = bucket.transactions.map((t) => ({
      id: t.id,
      label: t.label,
      amount: Number(t.amount),
      when: formatWhen(t.occurredAt),
      occurredAt: t.occurredAt.toISOString(),
      status: t.status === SavingsMovementStatus.SUCCESSFUL ? "successful" : t.status === SavingsMovementStatus.PENDING ? "pending" : "failed",
      direction: t.direction === SavingsMovementDirection.IN ? "in" : "out",
      bucketId: toSlug(bucket.type),
      category: t.category,
      planId: t.planId,
    }));

    return {
      bucket: bucketView,
      ongoingPlans,
      finishedPlans,
      activity,
    };
  }

  /** Quick Save into a bucket or specific plan. */
  async save(userId: string, dto: QuickSaveDto): Promise<SavingsActionResultView> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    if (user.rubiesAccountNumber) {
      const walletBalance = await this.rubies
        .getBalance(user.rubiesAccountNumber)
        .catch(() => null);
      if (walletBalance !== null && walletBalance < dto.amount) {
        throw new UnprocessableEntityException({
          error: "insufficient_funds",
          message: `Your available balance (₦${walletBalance.toLocaleString("en-NG")}) is less than ₦${dto.amount.toLocaleString("en-NG")}.`,
        });
      }
    }

    await this.ensureBuckets(userId);

    const ref = dto.reference ?? `save_${randomUUID()}`;
    const meta = BUCKET_METADATA[dto.bucketType];

    const result = await this.prisma.$transaction(async (tx) => {
      const bucket = await tx.savingsBucket.upsert({
        where: {
          userId_type: {
            userId,
            type: dto.bucketType,
          },
        },
        create: {
          userId,
          type: dto.bucketType,
          balance: dto.amount,
        },
        update: {
          balance: { increment: dto.amount },
        },
      });

      let planTitle: string | null = null;
      if (dto.planId) {
        const plan = await tx.savingsPlan.update({
          where: { id: dto.planId, userId },
          data: {
            currentAmount: { increment: dto.amount },
          },
        });
        planTitle = plan.title;
      }

      const label = planTitle
        ? `Quick Save → ${planTitle}`
        : `Quick Save → ${meta.title}`;

      const txn = await tx.savingsTransaction.create({
        data: {
          userId,
          bucketId: bucket.id,
          planId: dto.planId,
          amount: dto.amount,
          direction: SavingsMovementDirection.IN,
          status: SavingsMovementStatus.SUCCESSFUL,
          label,
          category: "Quick Save",
          reference: ref,
        },
      });

      return {
        transactionId: txn.id,
        amount: Number(txn.amount),
        bucketBalance: Number(bucket.balance),
        reference: ref,
        occurredAt: txn.occurredAt.toISOString(),
      };
    });

    return {
      success: true,
      ...result,
    };
  }

  /** Withdraw from a bucket back to main wallet balance. */
  async withdraw(userId: string, dto: WithdrawDto): Promise<SavingsActionResultView> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
    });

    if (user.pinHash) {
      if (!dto.pin) {
        throw new UnauthorizedException({
          error: "pin_required",
          message: "Transfer PIN is required to authorize withdrawal.",
        });
      }
      const verify = await this.pinService.verifyPin(userId, dto.pin);
      if (!verify.ok) {
        throw new UnauthorizedException({
          error: "invalid_pin",
          message: verify.reason ?? "Invalid PIN.",
        });
      }
    }

    const bucket = await this.prisma.savingsBucket.findUnique({
      where: {
        userId_type: {
          userId,
          type: dto.bucketType,
        },
      },
    });

    if (!bucket || Number(bucket.balance) < dto.amount) {
      throw new UnprocessableEntityException({
        error: "insufficient_bucket_balance",
        message: "Your savings bucket balance is less than the requested withdrawal amount.",
      });
    }

    let planTitle: string | null = null;
    if (dto.planId) {
      const plan = await this.prisma.savingsPlan.findUnique({
        where: { id: dto.planId, userId },
      });
      if (!plan || Number(plan.currentAmount) < dto.amount) {
        throw new UnprocessableEntityException({
          error: "insufficient_plan_balance",
          message: "The requested amount exceeds the funds in this savings pot.",
        });
      }
      if (
        plan.status === SavingsPlanStatus.LOCKED &&
        plan.unlockDate &&
        plan.unlockDate.getTime() > Date.now()
      ) {
        throw new ConflictException({
          error: "plan_is_locked",
          message: `This HardLock pot cannot be unlocked until ${plan.unlockDate.toLocaleDateString("en-GB")}.`,
        });
      }
      planTitle = plan.title;
    }

    const ref = dto.reference ?? `wd_${randomUUID()}`;
    const meta = BUCKET_METADATA[dto.bucketType];

    const result = await this.prisma.$transaction(async (tx) => {
      const updatedBucket = await tx.savingsBucket.update({
        where: { id: bucket.id },
        data: {
          balance: { decrement: dto.amount },
        },
      });

      if (dto.planId) {
        const remaining = await tx.savingsPlan.update({
          where: { id: dto.planId },
          data: {
            currentAmount: { decrement: dto.amount },
          },
        });
        if (Number(remaining.currentAmount) <= 0) {
          await tx.savingsPlan.update({
            where: { id: dto.planId },
            data: { status: SavingsPlanStatus.WITHDRAWN },
          });
        }
      }

      const label = planTitle
        ? `Withdrawal · ${planTitle}`
        : `Withdrawal · ${meta.title}`;

      const txn = await tx.savingsTransaction.create({
        data: {
          userId,
          bucketId: bucket.id,
          planId: dto.planId,
          amount: dto.amount,
          direction: SavingsMovementDirection.OUT,
          status: SavingsMovementStatus.SUCCESSFUL,
          label,
          category: "Withdrawal",
          reference: ref,
        },
      });

      return {
        transactionId: txn.id,
        amount: Number(txn.amount),
        bucketBalance: Number(updatedBucket.balance),
        reference: ref,
        occurredAt: txn.occurredAt.toISOString(),
      };
    });

    return {
      success: true,
      ...result,
    };
  }

  async createPlan(userId: string, dto: CreatePlanDto): Promise<SavingsPlanView> {
    await this.ensureBuckets(userId);

    const bucket = await this.prisma.savingsBucket.findUniqueOrThrow({
      where: {
        userId_type: {
          userId,
          type: dto.bucketType,
        },
      },
    });

    let unlockDate: Date | null = null;
    let rateLabel: string | null = null;
    let annualRate: number | null = null;
    let initialStatus: SavingsPlanStatus = SavingsPlanStatus.ACTIVE;

    if (dto.bucketType === SavingsBucketType.HARDLOCK) {
      const days = dto.durationDays ?? 60;
      unlockDate = new Date();
      unlockDate.setDate(unlockDate.getDate() + days);
      initialStatus = SavingsPlanStatus.LOCKED;

      if (days <= 60) {
        rateLabel = "15% p.a.";
        annualRate = 0.15;
      } else if (days <= 180) {
        rateLabel = "16% p.a.";
        annualRate = 0.16;
      } else if (days <= 364) {
        rateLabel = "17% p.a.";
        annualRate = 0.17;
      } else {
        rateLabel = "18% p.a.";
        annualRate = 0.18;
      }
    }

    const plan = await this.prisma.savingsPlan.create({
      data: {
        userId,
        bucketId: bucket.id,
        title: dto.title,
        emoji: dto.emoji,
        color: dto.color,
        colorBg: dto.colorBg,
        currentAmount: 0,
        targetAmount: dto.targetAmount,
        rateLabel,
        annualRate,
        unlockDate,
        cadence: dto.cadence,
        ruleConfig: dto.ruleConfig as any,
        status: initialStatus,
      },
    });

    // If an initial deposit amount was provided, execute save
    if (dto.amount && dto.amount > 0) {
      await this.save(userId, {
        bucketType: dto.bucketType,
        planId: plan.id,
        amount: dto.amount,
      });
      const updated = await this.prisma.savingsPlan.findUniqueOrThrow({
        where: { id: plan.id },
      });
      return {
        id: updated.id,
        title: updated.title,
        emoji: updated.emoji,
        color: updated.color,
        colorBg: updated.colorBg,
        amount: Number(updated.currentAmount),
        targetAmount: updated.targetAmount ? Number(updated.targetAmount) : null,
        rateLabel: updated.rateLabel,
        unlockLabel: updated.unlockDate
          ? `Unlocks ${updated.unlockDate.toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`
          : null,
        status: updated.status,
        createdAt: updated.createdAt.toISOString(),
      };
    }

    return {
      id: plan.id,
      title: plan.title,
      emoji: plan.emoji,
      color: plan.color,
      colorBg: plan.colorBg,
      amount: Number(plan.currentAmount),
      targetAmount: plan.targetAmount ? Number(plan.targetAmount) : null,
      rateLabel: plan.rateLabel,
      unlockLabel: plan.unlockDate
        ? `Unlocks ${plan.unlockDate.toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`
        : null,
      status: plan.status,
      createdAt: plan.createdAt.toISOString(),
    };
  }

  async updatePlan(userId: string, planId: string, dto: UpdatePlanDto): Promise<SavingsPlanView> {
    const plan = await this.prisma.savingsPlan.findUnique({
      where: { id: planId, userId },
    });
    if (!plan) {
      throw new NotFoundException({ error: "plan_not_found" });
    }

    const updated = await this.prisma.savingsPlan.update({
      where: { id: planId },
      data: {
        title: dto.title ?? undefined,
        status: dto.status ?? undefined,
        targetAmount: dto.targetAmount ?? undefined,
      },
    });

    return {
      id: updated.id,
      title: updated.title,
      emoji: updated.emoji,
      color: updated.color,
      colorBg: updated.colorBg,
      amount: Number(updated.currentAmount),
      targetAmount: updated.targetAmount ? Number(updated.targetAmount) : null,
      rateLabel: updated.rateLabel,
      unlockLabel: updated.unlockDate
        ? `Unlocks ${updated.unlockDate.toLocaleDateString("en-GB", { month: "short", year: "numeric" })}`
        : null,
      status: updated.status,
      createdAt: updated.createdAt.toISOString(),
    };
  }

  async getActivities(
    userId: string,
    bucketTypeOrSlug?: string,
    limit: number = 50,
  ): Promise<SavingsActivityView[]> {
    let bucketIdFilter: string | undefined = undefined;
    if (bucketTypeOrSlug) {
      const type = fromSlug(bucketTypeOrSlug);
      const bucket = await this.prisma.savingsBucket.findUnique({
        where: { userId_type: { userId, type } },
      });
      if (bucket) bucketIdFilter = bucket.id;
    }

    const txns = await this.prisma.savingsTransaction.findMany({
      where: {
        userId,
        bucketId: bucketIdFilter,
      },
      include: { bucket: true },
      orderBy: { occurredAt: "desc" },
      take: limit,
    });

    return txns.map((t) => ({
      id: t.id,
      label: t.label,
      amount: Number(t.amount),
      when: formatWhen(t.occurredAt),
      occurredAt: t.occurredAt.toISOString(),
      status: t.status === SavingsMovementStatus.SUCCESSFUL ? "successful" : t.status === SavingsMovementStatus.PENDING ? "pending" : "failed",
      direction: t.direction === SavingsMovementDirection.IN ? "in" : "out",
      bucketId: toSlug(t.bucket.type),
      category: t.category,
      planId: t.planId,
    }));
  }

  async getActivityDetail(userId: string, activityId: string): Promise<SavingsActivityDetailView> {
    const txn = await this.prisma.savingsTransaction.findUnique({
      where: { id: activityId, userId },
      include: { bucket: true },
    });

    if (!txn) {
      throw new NotFoundException({ error: "activity_not_found" });
    }

    const meta = BUCKET_METADATA[txn.bucket.type];
    const isIncome = txn.direction === SavingsMovementDirection.IN;

    const dateObj = new Date(txn.occurredAt);
    const dateLabel = `${dateObj.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })} – ${dateObj.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;

    return {
      id: txn.id,
      label: txn.label,
      amount: Number(txn.amount),
      when: formatWhen(txn.occurredAt),
      occurredAt: txn.occurredAt.toISOString(),
      status: txn.status === SavingsMovementStatus.SUCCESSFUL ? "successful" : txn.status === SavingsMovementStatus.PENDING ? "pending" : "failed",
      direction: isIncome ? "in" : "out",
      bucketId: toSlug(txn.bucket.type),
      category: txn.category,
      planId: txn.planId,
      bucketTitle: meta.title,
      bucketColor: meta.color,
      bucketSubtitle: meta.subtitle,
      method: isIncome ? "Transfer from Main" : "Transfer to Main",
      typeLabel: txn.category,
      sourceAccount: isIncome ? "Main treasury wallet" : meta.title,
      destination: isIncome ? meta.title : "Main treasury wallet",
      reference: txn.reference,
      sessionId: txn.id,
      dateLabel,
    };
  }
}
