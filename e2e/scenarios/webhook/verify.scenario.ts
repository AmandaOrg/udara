import { defineScenario } from '../../runner/define';
import { getWhatsappVerify } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';
import { e2eEnv } from '../../helpers/env';
import { ScenarioSkipped } from '../../runner/define';

export default defineScenario({
  name: 'webhook.verify.challenge',
  description:
    'GET /webhooks/whatsapp returns hub.challenge when verify token matches',
  tags: ['smoke', 'webhook'],
  async run(ctx) {
    if (!e2eEnv.verifyToken) {
      throw new ScenarioSkipped(
        'WHATSAPP_WEBHOOK_VERIFY_TOKEN not set in .env / .env.e2e',
      );
    }
    const challenge = `e2e-challenge-${Date.now()}`;
    ctx.log(`verify challenge=${challenge}`);
    const res = await getWhatsappVerify({
      mode: 'subscribe',
      token: e2eEnv.verifyToken,
      challenge,
    });
    expectStatus(res, 200);
    if (res.text !== challenge) {
      throw new Error(`expected challenge body ${challenge}, got ${res.text}`);
    }
  },
});
