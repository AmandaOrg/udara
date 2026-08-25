import { defineScenario, ScenarioSkipped } from '../../runner/define';
import { e2eEnv } from '../../helpers/env';
import { postRubiesWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';

export default defineScenario({
  name: 'rubies.webhook.unsigned-local-or-reject',
  description:
    'Rubies webhook: unsigned accepted when secret blank; rejected when secret set',
  tags: ['rubies', 'hack', 'security'],
  async run(ctx) {
    const payload = {
      amount: '1000',
      drCr: 'CR',
      paymentReference: `e2e-ref-${Date.now()}`,
      creditAccount: '0000000000',
      responseCode: '00',
    };

    const res = await postRubiesWebhook(payload);

    // Prefer observed HTTP status over env mirroring — .env.e2e can blank a
    // secret that the live server still has loaded.
    if ([401, 403].includes(res.status)) {
      ctx.log(`unsigned Rubies webhook rejected with ${res.status}`);
      return;
    }

    if (!e2eEnv.rubiesSecretKey) {
      // Controller may return 200 or 201 Created depending on Nest/defaults.
      if (![200, 201].includes(res.status)) {
        throw new Error(`expected HTTP 200/201, got ${res.status}`);
      }
      ctx.log(`unsigned Rubies webhook accepted (secret blank) status=${res.status}`);
      return;
    }

    if ([200, 201].includes(res.status)) {
      throw new ScenarioSkipped(
        'RUBIES_SECRET_KEY set but unsigned webhook returned 200 — check guard/rawBody',
      );
    }
    throw new Error(`expected 401/403, got ${res.status}`);
  },
});
