/**
 * Scenario fixtures — unique WA numbers; optional seeding via Prisma.
 */

import { postWhatsappWebhook } from './http';
import { expectStatus } from './assert';
import { uniqueWaNumber } from './ids';
import { textMessage } from './whatsapp';
import {
  getUserByWa,
  seedPostOnboardingAccount,
  waitForInboundSettled,
  waitForOutbound,
} from './db';
import type { ScenarioContext } from '../runner/define';

/** New WA number — first inbound creates the User row. */
export async function provisionNewUser(
  ctx: ScenarioContext,
  opts: { postOnboarding?: boolean; openText?: string } = {},
) {
  const wa = uniqueWaNumber();
  const started = new Date();
  ctx.log(`provisioning user ${wa}`);

  const { payload } = textMessage({
    from: wa,
    body: opts.openText ?? 'hello',
  });
  const res = await postWhatsappWebhook(payload);
  expectStatus(res, 200);

  // Allow async processing (controller acks then routes).
  await waitForOutbound(wa, {
    after: started,
    timeoutMs: 30_000,
  }).catch(async () => {
    // Onboarding/discovery may still create the user even if outbound is slow;
    // give user row a moment (Railway can be slow/flaky).
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (await getUserByWa(wa)) return;
      await new Promise((r) => setTimeout(r, 400));
    }
  });

  let user = await getUserByWa(wa);
  if (!user) {
    throw new Error(`provisionNewUser: user ${wa} not created after webhook`);
  }

  // The first outbound bubble arrives before the opening turn has finished
  // (the introduction is several bubbles, then a stage change). Seeding in
  // between is overwritten when that turn ends, and the next message waits
  // for it: one turn per user at a time.
  await waitForInboundSettled(wa, started);

  if (opts.postOnboarding) {
    user = await seedPostOnboardingAccount(wa);
    ctx.log(`seeded post-onboarding account for ${wa}`);
  }

  return { wa, user };
}

export { uniqueWaNumber };
