import { defineScenario } from '../../runner/define';
import { postWhatsappWebhook, request } from '../../helpers/http';
import { expect, expectStatus } from '../../helpers/assert';
import { textMessage, buttonReply } from '../../helpers/whatsapp';
import { getUserByWa, waitForOutbound } from '../../helpers/db';
import {
  bearer,
  requestCode,
  uniqueNigerianMobile,
  verifyCode,
} from '../../helpers/app';

export default defineScenario({
  name: 'app.sign-in.whatsapp-step-up',
  description:
    'A WhatsApp user without a PIN signing in to the app must approve it on WhatsApp; the same account is used',
  tags: ['app', 'security'],
  async run(ctx) {
    const phone = uniqueNigerianMobile();
    let started = new Date();
    expectStatus(
      await postWhatsappWebhook(
        textMessage({ from: phone, body: 'hello' }).payload,
      ),
      200,
    );
    await waitForOutbound(phone, { after: started, timeoutMs: 30_000 });
    const waUser = await getUserByWa(phone);
    expect(waUser?.phoneNumber).toBe(phone);
    ctx.log('WhatsApp user exists');

    await requestCode(phone);
    started = new Date();
    const verified = await verifyCode(phone);
    expectStatus(verified, 200);
    expect(verified.body.status).toBe('step_up_required');
    expect(verified.body.stepUp.method).toBe('whatsapp');
    const { challengeToken } = verified.body.stepUp;

    const pending = await request<any>('POST', '/v1/auth/step-up/whatsapp', {
      challengeToken,
    });
    expectStatus(pending, 202);

    const ask = await waitForOutbound(phone, {
      after: started,
      contains: /signing in to udara/i,
      timeoutMs: 20_000,
    });
    const approveId = JSON.stringify(ask.rawPayload).match(
      /login_approve:[0-9a-f-]+/,
    )?.[0];
    expect(approveId).toBeTruthy();
    ctx.log('approval request sent on WhatsApp');

    expectStatus(
      await postWhatsappWebhook(
        buttonReply({ from: phone, id: approveId!, title: "Yes, it's me" })
          .payload,
      ),
      200,
    );
    await waitForOutbound(phone, {
      after: started,
      contains: /signed in/i,
      timeoutMs: 20_000,
    });

    const approved = await request<any>('POST', '/v1/auth/step-up/whatsapp', {
      challengeToken,
    });
    expectStatus(approved, 200);
    expect(approved.body.user.id).toBe(waUser!.id);
    const me = await request<any>(
      'GET',
      '/v1/me',
      undefined,
      bearer(approved.body.tokens.accessToken),
    );
    expectStatus(me, 200);
    expect(me.body.whatsappLinked).toBe(true);
    ctx.log(
      'approved on WhatsApp; the app session belongs to the same account',
    );
  },
});
