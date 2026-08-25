import { defineScenario, ScenarioSkipped } from '../../runner/define';
import { e2eEnv } from '../../helpers/env';
import { postWhatsappWebhook } from '../../helpers/http';
import { textMessage } from '../../helpers/whatsapp';
import { uniqueWaNumber } from '../../helpers/ids';

export default defineScenario({
  name: 'security.signature.wrong-hmac-rejected',
  description:
    'When WHATSAPP_APP_SECRET is set, a bad X-Hub-Signature-256 is rejected',
  tags: ['hack', 'security'],
  async run(ctx) {
    if (!e2eEnv.whatsappAppSecret) {
      throw new ScenarioSkipped(
        'WHATSAPP_APP_SECRET blank — unsigned mode; set secret on server to exercise HMAC reject',
      );
    }
    const { payload } = textMessage({
      from: uniqueWaNumber(),
      body: 'hi',
    });
    const res = await postWhatsappWebhook(payload, {
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': 'sha256=deadbeef',
      },
    });
    if (res.status === 200) {
      throw new Error(
        'expected reject with bad HMAC, got 200 (is rawBody enabled on Nest?)',
      );
    }
    if (![401, 403].includes(res.status)) {
      throw new Error(`expected 401/403, got ${res.status}`);
    }
    ctx.log(`rejected with status ${res.status}`);
  },
});
