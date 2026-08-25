import { defineScenario } from '../../runner/define';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';
import { uniqueWaNumber, uniqueWamid } from '../../helpers/ids';

export default defineScenario({
  name: 'security.malformed.interactive-no-crash',
  description:
    'Malformed interactive payload is acked 200 and does not crash the process',
  tags: ['hack', 'security'],
  async run(ctx) {
    const wa = uniqueWaNumber();
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'E2E_WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                messages: [
                  {
                    id: uniqueWamid('malformed'),
                    from: wa,
                    timestamp: String(Math.floor(Date.now() / 1000)),
                    type: 'interactive',
                    interactive: { type: 'button_reply' }, // missing button_reply
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expectStatus(await postWhatsappWebhook(payload), 200);
    // Follow-up empty post proves process still up
    expectStatus(
      await postWhatsappWebhook({
        object: 'whatsapp_business_account',
        entry: [],
      }),
      200,
    );
    ctx.log('server still accepting webhooks after malformed interactive');
  },
});
