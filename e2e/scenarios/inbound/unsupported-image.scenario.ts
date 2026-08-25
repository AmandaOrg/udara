import { defineScenario } from '../../runner/define';
import { provisionNewUser } from '../../helpers/fixtures';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';
import { imageMessage } from '../../helpers/whatsapp';
import { waitForOutbound } from '../../helpers/db';

export default defineScenario({
  name: 'inbound.media.unsupported-image',
  description: 'Image inbound gets unsupported-media reply',
  tags: ['smoke', 'inbound'],
  async run(ctx) {
    const { wa } = await provisionNewUser(ctx, { postOnboarding: true });
    const started = new Date();
    const { payload } = imageMessage({ from: wa });
    expectStatus(await postWhatsappWebhook(payload), 200);
    const out = await waitForOutbound(wa, {
      after: started,
      contains: /can't do anything with that|send it as text/i,
      timeoutMs: 20_000,
    });
    ctx.log(out.textBody ?? '');
  },
});
