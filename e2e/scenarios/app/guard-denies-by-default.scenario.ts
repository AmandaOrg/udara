import { defineScenario } from '../../runner/define';
import { request } from '../../helpers/http';
import { expect, expectStatus } from '../../helpers/assert';
import {
  requestCode,
  uniqueNigerianMobile,
  verifyCode,
} from '../../helpers/app';

export default defineScenario({
  name: 'app.security.deny-by-default',
  description:
    'Every /v1 route needs a session, however the path is cased, and wrong codes are counted',
  tags: ['smoke', 'app', 'security'],
  async run(ctx) {
    expectStatus(await request('GET', '/v1/me'), 401);
    // Express matches routes case-insensitively; the guard must not care.
    expectStatus(await request('GET', '/V1/ME'), 401);
    expectStatus(
      await request('GET', '/v1/me', undefined, {
        headers: { Authorization: 'Bearer udr_at_not-a-real-token' },
      }),
      401,
    );
    ctx.log('no token, odd casing and a forged token are all refused');

    expectStatus(
      await request('POST', '/v1/auth/otp', { phoneNumber: '447700900123' }),
      400,
    );

    const phone = uniqueNigerianMobile();
    await requestCode(phone);
    const wrong = await verifyCode(phone, '000000');
    expectStatus(wrong, 401);
    expect(wrong.body.error).toBe('invalid_code');
    expect(wrong.body.attemptsLeft).toBe(4);
    ctx.log(
      'a wrong code is refused and counted against the five-guess budget',
    );
  },
});
