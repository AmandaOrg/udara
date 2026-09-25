import { defineScenario } from '../../runner/define';
import { request } from '../../helpers/http';
import { expect, expectStatus } from '../../helpers/assert';
import { prisma } from '../../helpers/db';
import {
  bearer,
  requestCode,
  setPinDirectly,
  uniqueNigerianMobile,
  verifyCode,
} from '../../helpers/app';

export default defineScenario({
  name: 'app.sign-in.pin-step-up',
  description:
    'A number whose account has a PIN gets no tokens from the SMS code alone; the PIN completes sign-in',
  tags: ['app', 'security'],
  async run(ctx) {
    const phone = uniqueNigerianMobile();
    const user = await prisma().user.create({ data: { phoneNumber: phone } });
    await setPinDirectly(user.id, '8317');

    await requestCode(phone);
    const verified = await verifyCode(phone);
    expectStatus(verified, 200);
    expect(verified.body.status).toBe('step_up_required');
    expect(verified.body.stepUp.method).toBe('pin');
    expect(verified.body.tokens).toBeUndefined();
    const { challengeToken } = verified.body.stepUp;
    ctx.log('the SMS code alone did not sign in');

    const wrong = await request<any>('POST', '/v1/auth/step-up/pin', {
      challengeToken,
      pin: '0000',
    });
    expectStatus(wrong, 401);
    expect(wrong.body.error).toBe('wrong_pin');

    const right = await request<any>('POST', '/v1/auth/step-up/pin', {
      challengeToken,
      pin: '8317',
    });
    expectStatus(right, 200);
    expect(right.body.status).toBe('authenticated');
    expectStatus(
      await request(
        'GET',
        '/v1/me',
        undefined,
        bearer(right.body.tokens.accessToken),
      ),
      200,
    );

    // Single use: the same challenge cannot mint a second session.
    expectStatus(
      await request('POST', '/v1/auth/step-up/pin', {
        challengeToken,
        pin: '8317',
      }),
      401,
    );
    ctx.log('wrong PIN refused, right PIN signed in, challenge not reusable');

    const refreshed = await request<any>('POST', '/v1/auth/refresh', {
      refreshToken: right.body.tokens.refreshToken,
    });
    expectStatus(refreshed, 200);
    expectStatus(
      await request(
        'GET',
        '/v1/me',
        undefined,
        bearer(right.body.tokens.accessToken),
      ),
      401,
    );
    expectStatus(
      await request(
        'GET',
        '/v1/me',
        undefined,
        bearer(refreshed.body.tokens.accessToken),
      ),
      200,
    );
    ctx.log('refresh rotated the tokens and retired the old access token');
  },
});
