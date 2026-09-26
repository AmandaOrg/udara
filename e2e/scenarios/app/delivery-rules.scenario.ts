import { OnboardingStage } from '@prisma/client';
import { defineScenario } from '../../runner/define';
import {
  postSignedRubiesWebhook,
  postWhatsappWebhook,
  request,
} from '../../helpers/http';
import { expect, expectStatus } from '../../helpers/assert';
import { textMessage } from '../../helpers/whatsapp';
import {
  prisma,
  waitForInboundSettled,
  waitForOutbound,
} from '../../helpers/db';
import {
  bearer,
  forwardedFromFreshAddress,
  requestCode,
  setPinDirectly,
  signInNewNumber,
  uniqueNigerianMobile,
  verifyCode,
} from '../../helpers/app';

const PIN = '5937';

/** A funded, onboarded account, so a credit gets the plain notice. */
async function giveAccount(userId: string, phoneNumber: string) {
  const accountNumber = `66${phoneNumber.slice(-8)}`;
  await prisma().user.update({
    where: { id: userId },
    data: {
      rubiesAccountNumber: accountNumber,
      rubiesAccountName: 'E2E Delivery',
      onboardingStage: OnboardingStage.COMPLETE,
    },
  });
  return accountNumber;
}

function credit(accountNumber: string) {
  return postSignedRubiesWebhook({
    amount: '5000',
    drCr: 'CR',
    responseCode: '00',
    creditAccount: accountNumber,
    paymentReference: `e2e-credit-${Date.now()}-${Math.random()}`,
    originatorName: 'E2E SENDER',
  });
}

async function registerPush(accessToken: string, suffix: string) {
  expectStatus(
    await request(
      'POST',
      '/v1/devices/push-token',
      { pushToken: `ExponentPushToken[e2e${suffix}]` },
      bearer(accessToken),
    ),
    204,
  );
}

async function appRows(userId: string) {
  return prisma().appMessage.findMany({
    where: { userId, direction: 'OUTBOUND', body: { contains: 'received' } },
  });
}

async function waitForAppRow(userId: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await appRows(userId);
    if (rows.length > 0) return rows;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no credit notice in the app chat for ${userId}`);
}

export default defineScenario({
  name: 'app.delivery.credit-notices',
  description:
    'A credit notice goes where the user is: into the app with one push for an app-only user; to WhatsApp, mirrored silently into the app, for a user last seen on WhatsApp',
  tags: ['app', 'delivery'],
  async run(ctx) {
    // --- An app-only user ---------------------------------------------------
    const appUser = await signInNewNumber();
    await registerPush(appUser.accessToken, Date.now().toString(36));
    const appAccount = await giveAccount(appUser.userId, appUser.phoneNumber);

    expect([200, 201]).toContain((await credit(appAccount)).status);
    const inApp = await waitForAppRow(appUser.userId);
    expect(inApp).toHaveLength(1);
    const appDevice = await prisma().device.findFirstOrThrow({
      where: { userId: appUser.userId },
    });
    expect(appDevice.lastPushAt).not.toBeNull();
    ctx.log('app-only: credit notice in the app chat, one push');

    // --- Someone on both, last seen on WhatsApp ------------------------------
    const phone = uniqueNigerianMobile();
    let started = new Date();
    expectStatus(
      await postWhatsappWebhook(
        textMessage({ from: phone, body: 'hi' }).payload,
      ),
      200,
    );
    await waitForInboundSettled(phone, started);
    const waUser = await prisma().user.findUniqueOrThrow({
      where: { whatsappNumber: phone },
    });
    await setPinDirectly(waUser.id, PIN);

    await requestCode(phone);
    const verified = await verifyCode(phone);
    expect(verified.body.stepUp?.method).toBe('pin');
    const signedIn = await request<any>(
      'POST',
      '/v1/auth/step-up/pin',
      { challengeToken: verified.body.stepUp.challengeToken, pin: PIN },
      forwardedFromFreshAddress(),
    );
    expectStatus(signedIn, 200);
    await registerPush(
      signedIn.body.tokens.accessToken,
      `b${Date.now().toString(36)}`,
    );
    const account = await giveAccount(waUser.id, phone);

    // Back to WhatsApp, so that is where they were last.
    started = new Date();
    expectStatus(
      await postWhatsappWebhook(
        textMessage({ from: phone, body: 'thanks' }).payload,
      ),
      200,
    );
    await waitForInboundSettled(phone, started);
    await prisma().device.updateMany({
      where: { userId: waUser.id },
      data: { lastPushAt: null },
    });

    started = new Date();
    expect([200, 201]).toContain((await credit(account)).status);
    await waitForOutbound(phone, {
      after: started,
      contains: /received ₦5,000/,
      timeoutMs: 15_000,
    });
    const mirrored = await waitForAppRow(waUser.id);
    expect(mirrored).toHaveLength(1);
    const device = await prisma().device.findFirstOrThrow({
      where: { userId: waUser.id },
    });
    expect(device.lastPushAt).toBeNull();
    ctx.log('both channels: WhatsApp notice, copied to the app, no push');
  },
});
