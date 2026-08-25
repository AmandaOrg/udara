import { defineScenario, ScenarioSkipped } from '../../runner/define';
import { e2eEnv } from '../../helpers/env';
import { postRubiesWebhook } from '../../helpers/http';

export default defineScenario({
  name: 'rubies.webhook.wrong-signature',
  description: 'When RUBIES_SECRET_KEY is set, a bad signature is rejected',
  tags: ['rubies', 'hack', 'security'],
  async run(ctx) {
    if (!e2eEnv.rubiesSecretKey) {
      throw new ScenarioSkipped(
        'RUBIES_SECRET_KEY blank — wrong-signature scenario requires a configured secret',
      );
    }
    const res = await postRubiesWebhook(
      {
        amount: '100',
        drCr: 'DR',
        paymentReference: `e2e-bad-${Date.now()}`,
      },
      { headers: { 'X-Webhook-Signature': 'v1=deadbeef' } },
    );
    if (res.status === 200) {
      throw new Error('expected signature rejection, got 200');
    }
    if (![401, 403].includes(res.status)) {
      throw new Error(`expected 401/403, got ${res.status}`);
    }
    ctx.log(`rejected with ${res.status}`);
  },
});
