/**
 * Mobile app API helpers. No imports from src/: the digest and hash formats
 * below are restated from src/app-auth/secret-hash.util.ts and
 * src/pin/pin.service.ts on purpose, so a change there that breaks sign-in
 * breaks these scenarios too.
 */

import { createHmac, randomBytes, scryptSync } from 'crypto';
import { prisma } from './db';
import { request } from './http';
import { expectStatus } from './assert';

export const KNOWN_CODE = '123456';

let seq = 0;

/** A fresh, valid Nigerian mobile in canonical form (13 digits, 2348...). */
export function uniqueNigerianMobile(): string {
  seq += 1;
  const clock = (Date.now() % 1_000_000).toString().padStart(6, '0');
  return `23480${clock}${(seq % 100).toString().padStart(2, '0')}`;
}

export function bearer(accessToken: string) {
  return { headers: { Authorization: `Bearer ${accessToken}` } };
}

/**
 * The runner cannot read an SMS. After asking the server for a code, swap the
 * stored digest for one of a code the runner knows. Needs the server's
 * OTP_PEPPER in the runner's environment.
 */
export async function plantKnownCode(phoneNumber: string): Promise<void> {
  const pepper = (process.env.OTP_PEPPER ?? '').trim();
  if (!pepper) {
    throw new Error(
      'plantKnownCode: set OTP_PEPPER for the e2e runner, matching the server',
    );
  }
  const latest = await prisma().authOtp.findFirst({
    where: { phoneNumber, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!latest) {
    throw new Error(`plantKnownCode: no open code for ${phoneNumber}`);
  }
  await prisma().authOtp.update({
    where: { id: latest.id },
    data: {
      codeHmac: createHmac('sha256', pepper)
        .update(`${phoneNumber}:${KNOWN_CODE}`, 'utf8')
        .digest('hex'),
    },
  });
}

/** Requests a code for the number and plants a known one in its place. */
export async function requestCode(phoneNumber: string): Promise<void> {
  expectStatus(
    await request(
      'POST',
      '/v1/auth/otp',
      { phoneNumber },
      forwardedFromFreshAddress(),
    ),
    202,
  );
  await plantKnownCode(phoneNumber);
}

/**
 * Every run comes from localhost, which would hit the per-address code cap
 * after a few runs. The server trusts one proxy hop, so present a fresh client
 * address the way Railway's edge would.
 */
function forwardedFromFreshAddress() {
  const octet = () => Math.floor(Math.random() * 254) + 1;
  return {
    headers: { 'X-Forwarded-For': `10.${octet()}.${octet()}.${octet()}` },
  };
}

export function verifyCode(phoneNumber: string, code = KNOWN_CODE) {
  return request<any>('POST', '/v1/auth/verify', {
    phoneNumber,
    code,
    device: { platform: 'ANDROID', name: 'e2e phone' },
  });
}

/** A transfer PIN on the user, in PinService's stored format. */
export async function setPinDirectly(
  userId: string,
  pin: string,
): Promise<void> {
  const salt = randomBytes(16);
  const derived = scryptSync(pin, salt, 32, { N: 16384, r: 8, p: 1 });
  await prisma().user.update({
    where: { id: userId },
    data: {
      pinHash: [
        'scrypt',
        16384,
        8,
        1,
        salt.toString('base64'),
        derived.toString('base64'),
      ].join('$'),
      pinSetAt: new Date(),
    },
  });
}

/** Signs a brand-new number in; it has nothing to step up with. */
export async function signInNewNumber(phoneNumber = uniqueNigerianMobile()) {
  await requestCode(phoneNumber);
  const verified = await verifyCode(phoneNumber);
  expectStatus(verified, 200);
  if (verified.body.status !== 'authenticated') {
    throw new Error(
      `signInNewNumber: expected authenticated, got ${verified.body.status}`,
    );
  }
  return {
    phoneNumber,
    userId: verified.body.user.id as string,
    accessToken: verified.body.tokens.accessToken as string,
  };
}

let clientSeq = 0;

/** A fresh `clientMessageId`. */
export function clientMessageId(): string {
  clientSeq += 1;
  return `e2e-${Date.now().toString(36)}-${clientSeq}`;
}

export interface ChatMessage {
  id: string;
  seq: string;
  direction: 'inbound' | 'outbound';
  kind: string;
  text: string | null;
  buttons?: { id: string; title: string }[];
  list?: { buttonLabel: string; rows: { id: string; title: string }[] };
  form?: { kind: string; token?: string };
}

export function chatSend(accessToken: string, body: Record<string, unknown>) {
  return request<any>(
    'POST',
    '/v1/chat/messages',
    { clientMessageId: clientMessageId(), ...body },
    bearer(accessToken),
  );
}

/**
 * Long-polls the chat from `after` until an outbound message matches, and
 * returns it with the cursor just past it. Throws with what did arrive.
 */
export async function waitForChat(
  accessToken: string,
  match: (m: ChatMessage) => boolean,
  opts: { after?: string; timeoutMs?: number } = {},
): Promise<{ message: ChatMessage; cursor: string; seen: ChatMessage[] }> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20_000);
  let cursor = opts.after;
  const seen: ChatMessage[] = [];
  while (Date.now() < deadline) {
    const query = new URLSearchParams({ waitMs: '5000' });
    if (cursor !== undefined) query.set('after', cursor);
    const page = await request<any>(
      'GET',
      `/v1/chat/messages?${query.toString()}`,
      undefined,
      bearer(accessToken),
    );
    expectStatus(page, 200);
    for (const message of page.body.messages as ChatMessage[]) {
      seen.push(message);
      if (message.direction === 'outbound' && match(message)) {
        return { message, cursor: message.seq, seen };
      }
    }
    if (page.body.cursor) cursor = page.body.cursor;
  }
  throw new Error(
    `waitForChat: no match; saw ${seen
      .map((m) => `${m.direction}/${m.kind}: ${(m.text ?? '').slice(0, 60)}`)
      .join(' || ')}`,
  );
}
