/**
 * Prisma read helpers for e2e asserts. Uses @prisma/client directly — no src/.
 */

import {
  OnboardingStage,
  PrismaClient,
  TransferDraftStatus,
  WhatsappMessageDirection,
} from '@prisma/client';
import { e2eEnv } from './env';

let client: PrismaClient | null = null;

const TRANSIENT_DB =
  /Can't reach database server|Server has closed the connection|P1001|P1017/i;

export function prisma(): PrismaClient {
  if (!client) {
    client = new PrismaClient({
      datasources: { db: { url: e2eEnv.databaseUrl } },
    });
  }
  return client;
}

function resetClient(): void {
  const old = client;
  client = null;
  if (old) {
    void old.$disconnect().catch(() => {});
  }
}

export async function disconnectPrisma(): Promise<void> {
  resetClient();
}

async function withDbRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 4,
): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String((err as Error)?.message ?? err);
      if (!TRANSIENT_DB.test(msg) || i === attempts - 1) throw err;
      resetClient();
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`${label}: db retry exhausted`);
}

export async function getUserByWa(whatsappNumber: string) {
  return withDbRetry('getUserByWa', () =>
    prisma().user.findUnique({ where: { whatsappNumber } }),
  );
}

export async function getActiveDraft(userId: string) {
  return withDbRetry('getActiveDraft', () =>
    prisma().transferDraft.findFirst({
      where: { userId, status: TransferDraftStatus.ACTIVE },
      orderBy: { createdAt: 'desc' },
    }),
  );
}

export async function getLatestTransaction(userId: string) {
  return withDbRetry('getLatestTransaction', () =>
    prisma().transaction.findFirst({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    }),
  );
}

export async function countInboundByWamid(waMessageId: string) {
  return withDbRetry('countInboundByWamid', () =>
    prisma().whatsappMessage.count({ where: { waMessageId } }),
  );
}

/**
 * Poll outbound WhatsappMessage rows for this WA number (stored in fromNumber
 * for OUTBOUND — see WhatsappMessageService.recordOutbound).
 */
export async function waitForOutbound(
  waNumber: string,
  opts: {
    contains?: string | RegExp;
    after?: Date;
    timeoutMs?: number;
    pollMs?: number;
  } = {},
) {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const pollMs = opts.pollMs ?? 250;
  const after = opts.after ?? new Date(Date.now() - 60_000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const rows = await withDbRetry('waitForOutbound', () =>
      prisma().whatsappMessage.findMany({
        where: {
          fromNumber: waNumber,
          direction: WhatsappMessageDirection.OUTBOUND,
          createdAt: { gte: after },
        },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    );

    for (const row of rows) {
      const text = row.textBody ?? '';
      if (!opts.contains) return row;
      if (typeof opts.contains === 'string') {
        if (text.toLowerCase().includes(opts.contains.toLowerCase())) {
          return row;
        }
      } else if (opts.contains.test(text)) {
        return row;
      }
    }

    await new Promise((r) => setTimeout(r, pollMs));
  }

  throw new Error(
    `waitForOutbound timed out after ${timeoutMs}ms for ${waNumber}` +
      (opts.contains ? ` containing ${String(opts.contains)}` : ''),
  );
}

export async function listOutboundSince(waNumber: string, after: Date) {
  return withDbRetry('listOutboundSince', () =>
    prisma().whatsappMessage.findMany({
      where: {
        fromNumber: waNumber,
        direction: WhatsappMessageDirection.OUTBOUND,
        createdAt: { gte: after },
      },
      orderBy: { createdAt: 'asc' },
    }),
  );
}

/** Promote a user to post-onboarding with a fake Rubies wallet for shortcut/wizard tests. */
export async function seedPostOnboardingAccount(whatsappNumber: string) {
  const user = await getUserByWa(whatsappNumber);
  if (!user) {
    throw new Error(`seedPostOnboardingAccount: no user for ${whatsappNumber}`);
  }
  return withDbRetry('seedPostOnboardingAccount', () =>
    prisma().user.update({
      where: { id: user.id },
      data: {
        onboardingStage: OnboardingStage.ACCOUNT_CREATED,
        rubiesAccountNumber: `9${whatsappNumber.slice(-9)}`.slice(0, 10),
        rubiesAccountId: `e2e-acc-${user.id.slice(0, 8)}`,
        rubiesAccountName: 'E2E Test User',
      },
    }),
  );
}
