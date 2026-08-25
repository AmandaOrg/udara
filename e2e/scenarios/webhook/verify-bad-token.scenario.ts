import { defineScenario } from '../../runner/define';
import { getWhatsappVerify } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';

export default defineScenario({
  name: 'webhook.verify.rejects-bad-token',
  description: 'GET verify with wrong token returns 403',
  tags: ['smoke', 'webhook', 'security'],
  async run() {
    const res = await getWhatsappVerify({
      mode: 'subscribe',
      token: 'definitely-wrong-token',
      challenge: 'nope',
    });
    expectStatus(res, 403);
  },
});
