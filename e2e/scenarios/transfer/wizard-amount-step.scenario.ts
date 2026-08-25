import { defineScenario } from '../../runner/define';
import { provisionNewUser } from '../../helpers/fixtures';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus, expect } from '../../helpers/assert';
import { textMessage } from '../../helpers/whatsapp';
import { getActiveDraft, waitForOutbound } from '../../helpers/db';
import { TransferDraftStep } from '@prisma/client';

export default defineScenario({
  name: 'transfer.wizard.amount-then-account',
  description:
    'Post-onboarding "transfer" starts wizard; amount advances draft to AWAITING_ACCOUNT_NUMBER',
  tags: ['smoke', 'flow', 'transfer'],
  async run(ctx) {
    const { wa, user } = await provisionNewUser(ctx, {
      postOnboarding: true,
    });

    let started = new Date();
    expectStatus(
      await postWhatsappWebhook(
        textMessage({ from: wa, body: 'transfer' }).payload,
      ),
      200,
    );
    await waitForOutbound(wa, {
      after: started,
      contains: /how much|send/i,
      timeoutMs: 20_000,
    });

    let draft = await getActiveDraft(user.id);
    expect(draft).toBeTruthy();
    expect(draft!.step).toBe(TransferDraftStep.AWAITING_AMOUNT);
    ctx.log(`draft ${draft!.id} at AWAITING_AMOUNT`);

    started = new Date();
    expectStatus(
      await postWhatsappWebhook(
        textMessage({ from: wa, body: '5000' }).payload,
      ),
      200,
    );
    await waitForOutbound(wa, {
      after: started,
      contains: /account number|10-digit/i,
      timeoutMs: 20_000,
    });

    draft = await getActiveDraft(user.id);
    expect(draft).toBeTruthy();
    expect(draft!.step).toBe(TransferDraftStep.AWAITING_ACCOUNT_NUMBER);
    expect(Number(draft!.amount)).toBe(5000);
    ctx.log(`draft advanced to AWAITING_ACCOUNT_NUMBER amount=5000`);
  },
});
