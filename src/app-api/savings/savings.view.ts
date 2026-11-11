import { SavingsBucketType, SavingsPlanStatus } from "@prisma/client";

export function toSlug(type: SavingsBucketType): string {
  switch (type) {
    case SavingsBucketType.SPEND_SAVE:
      return "spend-save";
    case SavingsBucketType.AUTO_SAVE:
      return "auto-save";
    case SavingsBucketType.HARDLOCK:
      return "hardlock";
    case SavingsBucketType.GOAL_BASED:
      return "goal-based";
  }
}

export function fromSlug(slug: string): SavingsBucketType {
  const norm = slug.toLowerCase().replace(/_/g, "-");
  switch (norm) {
    case "spend-save":
    case "spendsave":
      return SavingsBucketType.SPEND_SAVE;
    case "auto-save":
    case "autosave":
      return SavingsBucketType.AUTO_SAVE;
    case "hardlock":
      return SavingsBucketType.HARDLOCK;
    case "goal-based":
    case "goalbased":
    case "money-pots":
      return SavingsBucketType.GOAL_BASED;
    default:
      return SavingsBucketType.SPEND_SAVE;
  }
}

export interface SavingsActivityView {
  id: string;
  label: string;
  amount: number;
  when: string;
  occurredAt: string;
  status: "successful" | "pending" | "failed";
  direction: "in" | "out";
  bucketId: string;
  category: string;
  planId?: string | null;
}

export interface SavingsBucketItemView {
  id: string;
  label: string;
  amount: number;
  meta: string;
  occurredAt?: string;
  status?: "successful" | "pending" | "failed";
  direction?: "in" | "out";
}

export interface SavingsBucketView {
  id: string; // "spend-save" | "auto-save" | "hardlock" | "goal-based"
  type: SavingsBucketType;
  title: string;
  subtitle: string;
  amount: number;
  color: string;
  icon: string;
  items: SavingsBucketItemView[];
  activePlansCount: number;
}

export interface SavingsOverviewView {
  totalSavings: number;
  buckets: SavingsBucketView[];
  recentSaves: SavingsActivityView[];
}

export interface SavingsPlanView {
  id: string;
  title: string;
  emoji?: string | null;
  color?: string | null;
  colorBg?: string | null;
  amount: number;
  targetAmount?: number | null;
  rateLabel?: string | null;
  unlockLabel?: string | null;
  status: SavingsPlanStatus;
  meta?: string;
  scheduleLabel?: string;
  cadence?: string | null;
  tierId?: string | null;
  createdAt: string;
}

export interface SavingsBucketDetailView {
  bucket: SavingsBucketView;
  ongoingPlans: SavingsPlanView[];
  finishedPlans: SavingsPlanView[];
  activity: SavingsActivityView[];
}

export interface SavingsActionResultView {
  success: boolean;
  transactionId: string;
  amount: number;
  bucketBalance: number;
  reference: string;
  occurredAt: string;
}

export interface SavingsActivityDetailView extends SavingsActivityView {
  bucketTitle: string;
  bucketColor: string;
  bucketSubtitle: string;
  method: string;
  typeLabel: string;
  sourceAccount: string;
  destination: string;
  reference: string;
  sessionId: string;
  dateLabel: string;
}
