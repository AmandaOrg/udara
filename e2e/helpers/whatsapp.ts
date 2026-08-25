/**
 * Meta Cloud API webhook payload builders — shapes match parser unit tests.
 * No imports from `src/`.
 */

import { uniqueWamid } from './ids';

function entryWith(value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [{ id: 'E2E_WABA', changes: [{ value, field: 'messages' }] }],
  };
}

export function textMessage(params: {
  from: string;
  body: string;
  wamid?: string;
  timestamp?: string;
}) {
  const id = params.wamid ?? uniqueWamid('text');
  return {
    payload: entryWith({
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: '15550001111',
        phone_number_id: 'E2E_PHONE',
      },
      contacts: [{ profile: { name: 'E2E' }, wa_id: params.from }],
      messages: [
        {
          id,
          from: params.from,
          timestamp: params.timestamp ?? String(Math.floor(Date.now() / 1000)),
          type: 'text',
          text: { body: params.body },
        },
      ],
    }),
    wamid: id,
  };
}

export function buttonReply(params: {
  from: string;
  id: string;
  title: string;
  wamid?: string;
}) {
  const wamid = params.wamid ?? uniqueWamid('btn');
  return {
    payload: entryWith({
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: '15550001111',
        phone_number_id: 'E2E_PHONE',
      },
      messages: [
        {
          id: wamid,
          from: params.from,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'interactive',
          interactive: {
            type: 'button_reply',
            button_reply: { id: params.id, title: params.title },
          },
        },
      ],
    }),
    wamid,
  };
}

export function listReply(params: {
  from: string;
  id: string;
  title: string;
  wamid?: string;
}) {
  const wamid = params.wamid ?? uniqueWamid('list');
  return {
    payload: entryWith({
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: '15550001111',
        phone_number_id: 'E2E_PHONE',
      },
      messages: [
        {
          id: wamid,
          from: params.from,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'interactive',
          interactive: {
            type: 'list_reply',
            list_reply: { id: params.id, title: params.title },
          },
        },
      ],
    }),
    wamid,
  };
}

export function audioMessage(params: { from: string; wamid?: string }) {
  const wamid = params.wamid ?? uniqueWamid('audio');
  return {
    payload: entryWith({
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: '15550001111',
        phone_number_id: 'E2E_PHONE',
      },
      messages: [
        {
          id: wamid,
          from: params.from,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'audio',
          audio: { id: 'media-e2e', mime_type: 'audio/ogg' },
        },
      ],
    }),
    wamid,
  };
}

export function imageMessage(params: { from: string; wamid?: string }) {
  const wamid = params.wamid ?? uniqueWamid('image');
  return {
    payload: entryWith({
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: '15550001111',
        phone_number_id: 'E2E_PHONE',
      },
      messages: [
        {
          id: wamid,
          from: params.from,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'image',
          image: { id: 'media-e2e-img', mime_type: 'image/jpeg' },
        },
      ],
    }),
    wamid,
  };
}

export function flowReply(params: {
  from: string;
  responseJson: Record<string, unknown>;
  wamid?: string;
}) {
  const wamid = params.wamid ?? uniqueWamid('flow');
  return {
    payload: entryWith({
      messaging_product: 'whatsapp',
      metadata: {
        display_phone_number: '15550001111',
        phone_number_id: 'E2E_PHONE',
      },
      messages: [
        {
          id: wamid,
          from: params.from,
          timestamp: String(Math.floor(Date.now() / 1000)),
          type: 'interactive',
          interactive: {
            type: 'nfm_reply',
            nfm_reply: {
              name: 'flow',
              body: 'Sent',
              response_json: JSON.stringify(params.responseJson),
            },
          },
        },
      ],
    }),
    wamid,
  };
}
