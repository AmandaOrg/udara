import { defineScenario } from '../../runner/define';
import { provisionNewUser } from '../../helpers/fixtures';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';
import { textMessage } from '../../helpers/whatsapp';
import { waitForOutbound } from '../../helpers/db';

export default defineScenario({
  name: 'inbound.shortcuts.menu',
  description: 'Exact "menu" keyword sends the main menu interactive list',
  tags: ['smoke', 'inbound'],
  async run(ctx) {
    const { wa } = await provisionNewUser(ctx, { postOnboarding: true });
    const started = new Date();
    const { payload } = textMessage({ from: wa, body: 'menu' });
    expectStatus(await postWhatsappWebhook(payload), 200);
    const out = await waitForOutbound(wa, {
      after: started,
      contains: /what would you like|Open menu|balance|send money|menu:/i,
      timeoutMs: 20_000,
    });
    ctx.log(`menu outbound: ${out.textBody?.slice(0, 120)}`);
  },
});
