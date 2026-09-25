import { defineScenario } from '../../runner/define';
import { request } from '../../helpers/http';
import { expect, expectStatus } from '../../helpers/assert';
import { prisma } from '../../helpers/db';
import {
  bearer,
  requestCode,
  uniqueNigerianMobile,
  verifyCode,
} from '../../helpers/app';

export default defineScenario({
  name: 'app.sign-in.new-number',
  description:
    'A new number signs in with an SMS code, reaches /v1/me, and logging out kills the token',
  tags: ['smoke', 'app'],
  async run(ctx) {
    const phone = uniqueNigerianMobile();
    // Typed the local way; the server stores the canonical form.
    const typed = `0${phone.slice(3)}`;

    await requestCode(phone);
    expect(
      await prisma().user.findUnique({ where: { phoneNumber: phone } }),
    ).toBeNull();
    ctx.log('code requested; no user exists before it is verified');

    const verified = await verifyCode(typed);
    expectStatus(verified, 200);
    expect(verified.body.status).toBe('authenticated');
    expect(verified.body.user.isNewUser).toBe(true);
    const { accessToken } = verified.body.tokens;

    const me = await request<any>(
      'GET',
      '/v1/me',
      undefined,
      bearer(accessToken),
    );
    expectStatus(me, 200);
    expect(me.body.phoneNumber).toBe(phone);
    expect(me.body.whatsappLinked).toBe(false);
    expect(me.body.hasPin).toBe(false);

    expectStatus(
      await request('POST', '/v1/auth/logout', undefined, bearer(accessToken)),
      204,
    );
    expectStatus(
      await request('GET', '/v1/me', undefined, bearer(accessToken)),
      401,
    );
    ctx.log('signed in, read /v1/me, logged out, token dead');
  },
});
