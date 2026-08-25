import { defineScenario } from '../../runner/define';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';

export default defineScenario({
  name: 'webhook.post.empty-payload-acks',
  description: 'POST /webhooks/whatsapp with empty entry still acks 200',
  tags: ['smoke', 'webhook'],
  async run() {
    const res = await postWhatsappWebhook({
      object: 'whatsapp_business_account',
      entry: [],
    });
    expectStatus(res, 200);
  },
});
