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

  getChat(chatId) {
    return call('getChat', { chat_id: chatId });
  },

  async getMyMember(chatId) {
    const me = await call('getMe');
    return call('getChatMember', { chat_id: chatId, user_id: me.id });
  },

  createForumTopic(chatId, name) {
    return call('createForumTopic', { chat_id: chatId, name: name.slice(0, 128) });
  },

  react(chatId, messageId, emoji) {
    return call('setMessageReaction', {
      chat_id: chatId,
      message_id: messageId,
      reaction: [{ type: 'emoji', emoji }],
    });
  },

  editMessageText(chatId, messageId, text, extra = {}) {
    return call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      ...extra,
    });
  },

  answerCallback(callbackQueryId, text) {
    return call('answerCallbackQuery', { callback_query_id: callbackQueryId, ...(text ? { text } : {}) });
  },

  /** Long-polls Telegram forever and passes messages and button presses to the handlers. */
  async listen(onMessage, onCallback) {
    let offset = 0;
    for (;;) {
      try {
        const updates = await call('getUpdates', {
          offset,
          timeout: 50,
          allowed_updates: ['message', 'callback_query'],
        });
        for (const update of updates) {
          offset = update.update_id + 1;
          const handle = update.message
            ? onMessage(update.message)
            : update.callback_query
              ? onCallback(update.callback_query)
              : null;
          await handle?.catch((err) => console.error('Telegram handler error:', err));
        }
      } catch (err) {
        console.error('Telegram polling error:', err.message);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  },
};
