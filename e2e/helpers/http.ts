import { createHmac } from 'crypto';
import { e2eEnv } from './env';

export interface HttpResponse<T = unknown> {
  status: number;
  body: T;
  headers: Record<string, string>;
  durationMs: number;
  /** Raw response text when body isn't JSON. */
  text: string;
}

export interface RequestOpts {
  headers?: Record<string, string>;
}

async function request<T = unknown>(
  method: string,
  urlPath: string,
  body?: unknown,
  opts: RequestOpts = {},
): Promise<HttpResponse<T>> {
  const url = urlPath.startsWith('http')
    ? urlPath
    : `${e2eEnv.baseUrl}${urlPath.startsWith('/') ? '' : '/'}${urlPath}`;

  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(opts.headers ?? {}),
  };

  let payload: string | undefined;
  if (body !== undefined) {
    payload = typeof body === 'string' ? body : JSON.stringify(body);
    if (!headers['Content-Type'] && !headers['content-type']) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const start = Date.now();
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: payload });
  } catch (err) {
    throw new Error(
      `e2e HTTP ${method} ${url} failed: ${String(err)}\n${e2eEnv.baseUrl} — is the server up?`,
    );
  }

  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }

  const outHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    outHeaders[k] = v;
  });

  return {
    status: res.status,
    body: parsed as T,
    headers: outHeaders,
    durationMs: Date.now() - start,
    text,
  };
}

export function postWhatsappWebhook(
  payload: unknown,
  opts: RequestOpts = {},
): Promise<HttpResponse> {
  return request('POST', '/webhooks/whatsapp', payload, opts);
}

export function getWhatsappVerify(query: {
  mode: string;
  token: string;
  challenge: string;
}): Promise<HttpResponse> {
  const qs = new URLSearchParams({
    'hub.mode': query.mode,
    'hub.verify_token': query.token,
    'hub.challenge': query.challenge,
  });
  return request('GET', `/webhooks/whatsapp?${qs.toString()}`);
}

export function postRubiesWebhook(
  payload: unknown,
  opts: RequestOpts = {},
): Promise<HttpResponse> {
  return request('POST', e2eEnv.rubiesWebhookPath, payload, opts);
}

/**
 * A Rubies webhook signed as Rubies signs it (`t=<unix>,v1=<hmac>` over
 * "t.body"), with the RUBIES_SECRET_KEY the runner shares with the server.
 * Unsigned when no secret is configured, which the server then accepts only
 * under ALLOW_UNSIGNED_WEBHOOKS.
 */
export function postSignedRubiesWebhook(
  payload: unknown,
): Promise<HttpResponse> {
  const body = JSON.stringify(payload);
  if (!e2eEnv.rubiesSecretKey) return postRubiesWebhook(body);
  const t = Math.floor(Date.now() / 1000).toString();
  const v1 = createHmac('sha256', e2eEnv.rubiesSecretKey)
    .update(`${t}.${body}`)
    .digest('hex');
  return postRubiesWebhook(body, {
    headers: { 'X-Webhook-Signature': `t=${t},v1=${v1}` },
  });
}

export { request };
