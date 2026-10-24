import { defineScenario } from '../../runner/define';
import { request } from '../../helpers/http';
import { expect, expectStatus } from '../../helpers/assert';
import { prisma } from '../../helpers/db';
import {
  bearer,
  clientMessageId,
  signInNewNumber,
  waitForChat,
} from '../../helpers/app';

export default defineScenario({
  name: 'app.chat.choices-are-scoped',
  description:
    "A choice must name a message offered to the same user: someone else's message, or an id it did not offer, is a 404; a retried send is handled once",
  tags: ['app', 'security'],
  async run(ctx) {
    const alice = await signInNewNumber();
    const bob = await signInNewNumber();

    expectStatus(
      await request(
        'POST',
        '/v1/chat/start',
        { clientMessageId: clientMessageId() },
        bearer(alice.accessToken),
      ),
      202,
    );
    const offer = await waitForChat(alice.accessToken, (m) =>
      (m.buttons ?? []).some((b) => b.id === 'intro:yes'),
    );

    const fromBob = await request<any>(
      'POST',
      '/v1/chat/messages',
      {
        clientMessageId: clientMessageId(),
        reply: { messageId: offer.message.id, choiceId: 'intro:yes' },
      },
      bearer(bob.accessToken),
    );
    expectStatus(fromBob, 404);
    ctx.log("another user's message: 404");

    const notOffered = await request<any>(
      'POST',
      '/v1/chat/messages',
      {
        clientMessageId: clientMessageId(),
        reply: { messageId: offer.message.id, choiceId: 'confirm:anything' },
      },
      bearer(alice.accessToken),
    );
    expectStatus(notOffered, 404);
    ctx.log('an id the message did not offer: 404');

    const recorded = await prisma().appMessage.count({
      where: {
        userId: { in: [alice.userId, bob.userId] },
        direction: 'INBOUND',
        kind: 'CHOICE',
      },
    });
    expect(recorded).toBe(0);

    const retryId = clientMessageId();
    const first = await request<any>(
      'POST',
      '/v1/chat/messages',
      { clientMessageId: retryId, text: 'hello?' },
      bearer(alice.accessToken),
    );
    const second = await request<any>(
      'POST',
      '/v1/chat/messages',
      { clientMessageId: retryId, text: 'hello?' },
      bearer(alice.accessToken),
    );
    expectStatus(first, 202);
    expectStatus(second, 202);
    expect(second.body.id).toBe(first.body.id);
    expect(
      await prisma().appMessage.count({
        where: { userId: alice.userId, clientMessageId: retryId },
      }),
    ).toBe(1);
    ctx.log('a retried send is the same message, stored once');
  },
});
