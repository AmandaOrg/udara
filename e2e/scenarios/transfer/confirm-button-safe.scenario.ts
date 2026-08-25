import { defineScenario } from '../../runner/define';
import { provisionNewUser } from '../../helpers/fixtures';
import { postWhatsappWebhook } from '../../helpers/http';
import { expectStatus } from '../../helpers/assert';
import { buttonReply } from '../../helpers/whatsapp';
import { waitForOutbound } from '../../helpers/db';

export default defineScenario({
  name: 'transfer.confirm.expired-button-safe',
  description:
    'Stale confirm_transfer / cancel_transfer button ids do not 500 the webhook',
  tags: ['flow', 'transfer'],
  async run(ctx) {
    const { wa } = await provisionNewUser(ctx, { postOnboarding: true });
    const started = new Date();

    const confirm = buttonReply({
      from: wa,
      id: 'confirm_transfer:00000000-0000-0000-0000-000000000000',
      title: 'Confirm',
    });
    expectStatus(await postWhatsappWebhook(confirm.payload), 200);

    const cancel = buttonReply({
      from: wa,
      id: 'cancel_transfer:00000000-0000-0000-0000-000000000000',
      title: 'Cancel',
    });
    expectStatus(await postWhatsappWebhook(cancel.payload), 200);

    // May or may not send a user-facing error; webhook must stay 200 and process.
    await waitForOutbound(wa, { after: started, timeoutMs: 15_000 }).catch(
      () => {
        ctx.log('no outbound required — webhook acked without crash');
      },
    );
  },
});
