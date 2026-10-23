import { config } from './config.js';
import { store } from './store.js';

const { clientId, clientSecret, authUrl, apiUrl, userAgent } = config.allegro;
const BASIC = 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
const MEDIA_TYPE = 'application/vnd.allegro.public.v1+json';

// Allegro requires its generated User-Agent on every request, auth included.
const fetch = (url, init = {}) =>
  globalThis.fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': userAgent } });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- OAuth (device flow) ----------

function saveTokenResponse(body) {
  store.setTokens({
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + body.expires_in * 1000,
  });
}

/**
 * Asks the seller to approve the app in the browser.
 * `onLink(url)` is called with the link to open; resolves once approved.
 */
export async function authorizeDevice(onLink) {
  const res = await fetch(`${authUrl}/device`, {
    method: 'POST',
    headers: { Authorization: BASIC, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId }),
  });
  if (!res.ok) throw new Error(`Allegro device auth failed: ${res.status} ${await res.text()}`);
  const device = await res.json();

  await onLink(device.verification_uri_complete);

  let interval = (device.interval || 5) * 1000;
  const deadline = Date.now() + device.expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const params = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: device.device_code,
    });
    const tokenRes = await fetch(`${authUrl}/token?${params}`, {
      method: 'POST',
      headers: { Authorization: BASIC },
    });
    const body = await tokenRes.json();
    if (tokenRes.ok) {
      saveTokenResponse(body);
      return;
    }
    if (body.error === 'authorization_pending') continue;
    if (body.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new Error(`Allegro authorization failed: ${body.error} ${body.error_description ?? ''}`);
  }
  throw new Error('Allegro authorization link expired, restart the bot to get a new one');
}

let refreshing = null;

async function refreshTokens() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: store.tokens.refreshToken,
  });
  const res = await fetch(`${authUrl}/token?${params}`, {
    method: 'POST',
    headers: { Authorization: BASIC },
  });
  const body = await res.json();
  if (!res.ok) {
    store.setTokens(null);
    throw new Error(`Allegro token refresh failed (${body.error}). Restart the bot to log in again.`);
  }
  saveTokenResponse(body);
}

async function accessToken() {
  if (!store.tokens) throw new Error('Not logged in to Allegro');
  if (Date.now() > store.tokens.expiresAt - 5 * 60 * 1000) {
    refreshing ??= refreshTokens().finally(() => (refreshing = null));
    await refreshing;
  }
  return store.tokens.accessToken;
}

// ---------- REST ----------

async function api(method, path, body, retried = false) {
  const res = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      Accept: MEDIA_TYPE,
      ...(body ? { 'Content-Type': MEDIA_TYPE } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401 && !retried) {
    store.setTokens({ ...store.tokens, expiresAt: 0 }); // force refresh
    return api(method, path, body, true);
  }
  if (!res.ok) throw new Error(`Allegro ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

export const allegro = {
  /** Most recently active threads first. */
  async listThreads(limit = 20) {
    const { threads } = await api('GET', `/messaging/threads?limit=${limit}&offset=0`);
    return threads;
  },

  /** Newest messages first. */
  async listMessages(threadId, limit = 20) {
    const { messages } = await api('GET', `/messaging/threads/${threadId}/messages?limit=${limit}&offset=0`);
    return messages;
  },

  /** Returns the created message (with its `id`). */
  sendMessage(threadId, text) {
    return api('POST', `/messaging/threads/${threadId}/messages`, { text, attachments: [] });
  },

  markThreadRead(threadId) {
    return api('PUT', `/messaging/threads/${threadId}/read`, { read: true });
  },

  /** Buyer's first name from an order (needs the orders:read scope), or null. */
  async orderBuyerFirstName(orderId) {
    try {
      const order = await api('GET', `/order/checkout-forms/${orderId}`);
      return order?.buyer?.firstName ?? null;
    } catch {
      return null;
    }
  },

  async offerTitle(offerId) {
    try {
      const offer = await api('GET', `/sale/product-offers/${offerId}`);
      return offer?.name ?? null;
    } catch {
      return null;
    }
  },
};
