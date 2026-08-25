import { defineScenario } from '../../runner/define';
import { uniqueWaNumber, uniqueWamid } from '../../helpers/ids';
import { textMessage } from '../../helpers/whatsapp';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus, expect } from '../../helpers/assert';
import { countInboundByWamid, waitForOutbound } from '../../helpers/db';

export default defineScenario({
  name: 'security.idempotency.wamid-redelivery',
  description:
    'Same waMessageId redelivered twice creates one inbound row and does not double-route',
  tags: ['hack', 'security', 'smoke'],
  async run(ctx) {
    const wa = uniqueWaNumber();
    const wamid = uniqueWamid('idem');
    const { payload } = textMessage({
      from: wa,
      body: 'hello idempotent',
      wamid,
    });

    const started = new Date();
    expectStatus(await postWhatsappWebhook(payload), 200);
    await waitForOutbound(wa, { after: started, timeoutMs: 20_000 });

    expectStatus(await postWhatsappWebhook(payload), 200);
    // Brief wait for any erroneous second processing
    await new Promise((r) => setTimeout(r, 1500));

    const count = await countInboundByWamid(wamid);
    expect(count).toBe(1);
    ctx.log(`single inbound row for ${wamid}`);
  },
});
