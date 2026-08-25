import { defineScenario } from '../../runner/define';
import { provisionNewUser } from '../../helpers/fixtures';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';
import { audioMessage } from '../../helpers/whatsapp';
import { waitForOutbound } from '../../helpers/db';

export default defineScenario({
  name: 'inbound.media.audio-stub',
  description: 'Audio inbound gets the voice-note stub reply',
  tags: ['smoke', 'inbound'],
  async run(ctx) {
    const { wa } = await provisionNewUser(ctx, { postOnboarding: true });
    const started = new Date();
    const { payload } = audioMessage({ from: wa });
    expectStatus(await postWhatsappWebhook(payload), 200);
    const out = await waitForOutbound(wa, {
      after: started,
      contains: /voice note|type that instead/i,
      timeoutMs: 20_000,
    });
    ctx.log(out.textBody ?? '');
  },
});
