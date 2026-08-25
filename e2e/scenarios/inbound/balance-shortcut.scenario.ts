import { defineScenario } from '../../runner/define';
import { provisionNewUser } from '../../helpers/fixtures';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';
import { textMessage } from '../../helpers/whatsapp';
import { waitForOutbound } from '../../helpers/db';

export default defineScenario({
  name: 'inbound.shortcuts.balance',
  description:
    'Exact "balance" keyword triggers account balance read (dry-run Rubies)',
  tags: ['smoke', 'inbound'],
  async run(ctx) {
    const { wa } = await provisionNewUser(ctx, { postOnboarding: true });
    const started = new Date();
    const { payload } = textMessage({ from: wa, body: 'balance' });
    expectStatus(await postWhatsappWebhook(payload), 200);
    const out = await waitForOutbound(wa, {
      after: started,
      contains: /balance|₦|couldn.t reach rubies|rubies/i,
      timeoutMs: 25_000,
    });
    ctx.log(`balance outbound: ${out.textBody}`);
  },
});
