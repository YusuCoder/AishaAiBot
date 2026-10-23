import { config } from './config.js';

const BASE = `https://api.telegram.org/bot${config.telegram.token}`;

async function call(method, params = {}) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`Telegram ${method} failed: ${body.description}`);
  return body.result;
}

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export const telegram = {
  sendMessage(chatId, text, extra = {}) {
    return call('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  },

  /** Long-polls Telegram forever and passes every incoming message to the handler. */
  async listen(onMessage) {
    let offset = 0;
    for (;;) {
      try {
        const updates = await call('getUpdates', { offset, timeout: 50, allowed_updates: ['message'] });
        for (const update of updates) {
          offset = update.update_id + 1;
          if (update.message) {
            await onMessage(update.message).catch((err) => console.error('Telegram handler error:', err));
          }
        }
      } catch (err) {
        console.error('Telegram polling error:', err.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  },
};
