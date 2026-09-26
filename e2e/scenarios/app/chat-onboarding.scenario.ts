import { OnboardingStage } from '@prisma/client';
import { defineScenario } from '../../runner/define';
import { request } from '../../helpers/http';
import { expect, expectStatus } from '../../helpers/assert';
import { prisma } from '../../helpers/db';
import {
  bearer,
  chatSend,
  clientMessageId,
  signInNewNumber,
  waitForChat,
} from '../../helpers/app';

const ID_NUMBER = '22100000001';
const DATE_OF_BIRTH = '1995-05-05';
const PIN = '4826';

export default defineScenario({
  name: 'app.chat.onboarding-to-pin',
  description:
    'An app-only user is onboarded in the in-app chat: intro, terms, KYC form, then a PIN before anything else; no ID number or PIN is stored',
  tags: ['app', 'onboarding', 'security'],
  async run(ctx) {
    const { accessToken, userId } = await signInNewNumber();
    const auth = bearer(accessToken);

    expectStatus(
      await request(
        'POST',
        '/v1/chat/start',
        { clientMessageId: clientMessageId() },
        auth,
      ),
      202,
    );
    const intro = await waitForChat(accessToken, (m) =>
      (m.buttons ?? []).some((b) => b.id === 'intro:yes'),
    );
    ctx.log('introduced, with the comprehension buttons');

    expectStatus(
      await chatSend(accessToken, {
        reply: { messageId: intro.message.id, choiceId: 'intro:yes' },
      }),
      202,
    );
    const terms = await waitForChat(
      accessToken,
      (m) => (m.buttons ?? []).some((b) => b.id === 'terms:agree'),
      { after: intro.cursor },
    );
    expectStatus(
      await chatSend(accessToken, {
        reply: { messageId: terms.message.id, choiceId: 'terms:agree' },
      }),
      202,
    );
    const identity = await waitForChat(
      accessToken,
      (m) => /4 quick things/.test(m.text ?? ''),
      { after: terms.cursor },
    );
    ctx.log('terms agreed; asked the four questions');

    // Free text reaches the onboarding model from the app too. The stub never
    // extracts, so it answers and the stage stays put.
    expectStatus(
      await chatSend(accessToken, { text: "i'm ada, lagos, 300k a month" }),
      202,
    );
    await waitForChat(accessToken, (m) => /stub LLM/i.test(m.text ?? ''), {
      after: identity.cursor,
    });

    // Arrange past IDENTITY, which only a real model can extract, as the
    // server would leave it: the answers saved, the stage advanced, and the
    // frequency buttons sent.
    const db = prisma();
    await db.user.update({
      where: { id: userId },
      data: {
        name: 'Ada',
        city: 'Lagos',
        monthlyIncome: 300_000,
        onboardingStage: OnboardingStage.FREQUENCY_CHECK,
      },
    });
    await db.onboardingSession.updateMany({
      where: { userId },
      data: { stage: OnboardingStage.FREQUENCY_CHECK },
    });
    const frequency = await db.appMessage.create({
      data: {
        userId,
        direction: 'OUTBOUND',
        kind: 'BUTTONS',
        body: 'got it. how often does this happen?',
        payload: {
          buttons: [
            { id: 'freq:weekly', title: 'Weekly' },
            { id: 'freq:monthly', title: 'Monthly' },
          ],
        },
      },
    });

    expectStatus(
      await chatSend(accessToken, {
        reply: { messageId: frequency.id, choiceId: 'freq:weekly' },
      }),
      202,
    );
    const kycForm = await waitForChat(
      accessToken,
      (m) => m.kind === 'form_request' && m.form?.kind === 'KYC',
      { after: frequency.seq.toString() },
    );
    ctx.log('asked for identity through a form, not the chat');

    expectStatus(
      await request(
        'POST',
        '/v1/forms/kyc',
        {
          clientMessageId: clientMessageId(),
          token: kycForm.message.form!.token,
          firstName: 'Ada',
          lastName: 'Obi',
          idType: 'BVN',
          idNumber: ID_NUMBER,
          email: 'ada.e2e@example.com',
          dateOfBirth: DATE_OF_BIRTH,
        },
        auth,
      ),
      202,
    );
    const pinForm = await waitForChat(
      accessToken,
      (m) => m.kind === 'form_request' && m.form?.kind === 'PIN_SETUP',
      { after: kycForm.cursor, timeoutMs: 30_000 },
    );
    const created = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(created.rubiesAccountNumber).toBeTruthy();
    expect(created.onboardingStage).toBe(OnboardingStage.MONEY_STORY);
    expect(created.pinHash).toBeNull();
    expect(
      pinForm.seen.some((m) => /set the 4-digit pin/.test(m.text ?? '')),
    ).toBe(true);
    expect(
      pinForm.seen.some((m) => /what financial goal/.test(m.text ?? '')),
    ).toBe(false);
    ctx.log('account created; PIN asked for before anything else');

    // Onboarding holds until the PIN is set.
    expectStatus(
      await chatSend(accessToken, { text: 'i want to save for a car' }),
      202,
    );
    const again = await waitForChat(
      accessToken,
      (m) => m.kind === 'form_request' && m.form?.kind === 'PIN_SETUP',
      { after: pinForm.cursor },
    );
    expect(
      again.seen.some((m) => /set your transfer pin first/.test(m.text ?? '')),
    ).toBe(true);

    expectStatus(
      await request(
        'POST',
        '/v1/forms/pin',
        {
          clientMessageId: clientMessageId(),
          token: again.message.form!.token,
          pin: PIN,
          pinConfirm: PIN,
        },
        auth,
      ),
      202,
    );
    await waitForChat(
      accessToken,
      (m) => /what financial goal/.test(m.text ?? ''),
      { after: again.cursor },
    );
    const withPin = await db.user.findUniqueOrThrow({ where: { id: userId } });
    expect(withPin.pinHash).toBeTruthy();
    ctx.log('PIN set; onboarding carried on with the money story');

    const stored = JSON.stringify(
      await db.appMessage.findMany({ where: { userId } }),
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    );
    expect(stored.includes(ID_NUMBER)).toBe(false);
    expect(stored.includes(DATE_OF_BIRTH)).toBe(false);
    expect(stored.includes(`"${PIN}"`)).toBe(false);
    ctx.log('no ID number, date of birth or PIN in any stored chat row');
  },
});
