import { defineScenario } from '../../runner/define';
import { e2eEnv } from '../../helpers/env';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus, expect } from '../../helpers/assert';
import { textMessage } from '../../helpers/whatsapp';
import { uniqueWaNumber } from '../../helpers/ids';
import { countInboundByWamid } from '../../helpers/db';
import { ScenarioSkipped } from '../../runner/define';

export default defineScenario({
  name: 'security.signature.unsigned-accepted-when-secret-blank',
  description:
    'When WHATSAPP_APP_SECRET is blank, unsigned webhooks are accepted (local mode)',
  tags: ['hack', 'security', 'smoke'],
  async run(ctx) {
    if (e2eEnv.whatsappAppSecret) {
      throw new ScenarioSkipped(
        'WHATSAPP_APP_SECRET is set — unsigned-accept scenario only applies in local blank-secret mode',
      );
    }
    const wa = uniqueWaNumber();
    const { payload, wamid } = textMessage({ from: wa, body: 'hello e2e' });
    expectStatus(await postWhatsappWebhook(payload), 200);
    // Give async persist a beat
    const deadline = Date.now() + 10_000;
    let count = 0;
    while (Date.now() < deadline) {
      count = await countInboundByWamid(wamid);
      if (count >= 1) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(count).toBeGreaterThanOrEqual(1);
    ctx.log(`inbound persisted for ${wamid}`);
  },
});
