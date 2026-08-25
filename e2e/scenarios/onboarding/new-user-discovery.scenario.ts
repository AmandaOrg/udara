import { defineScenario } from '../../runner/define';
import { uniqueWaNumber } from '../../helpers/ids';
import { textMessage } from '../../helpers/whatsapp';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus, expect } from '../../helpers/assert';
import { getUserByWa, waitForOutbound } from '../../helpers/db';
import { OnboardingStage } from '@prisma/client';

export default defineScenario({
  name: 'onboarding.new-user.discovery',
  description:
    'Brand-new WA number creates a User and receives an onboarding-stage reply',
  tags: ['onboarding', 'smoke'],
  async run(ctx) {
    const wa = uniqueWaNumber();
    const started = new Date();
    expectStatus(
      await postWhatsappWebhook(
        textMessage({ from: wa, body: 'hi udara' }).payload,
      ),
      200,
    );

    await waitForOutbound(wa, { after: started, timeoutMs: 25_000 });

    const user = await getUserByWa(wa);
    expect(user).toBeTruthy();
    // Fresh users start at DISCOVERY (or may have advanced one step on first text).
    const stage = user!.onboardingStage;
    ctx.log(`user ${wa} stage=${stage}`);
    expect([
      OnboardingStage.DISCOVERY,
      OnboardingStage.WELCOME,
      OnboardingStage.IDENTITY,
    ]).toContain(stage);
  },
});
