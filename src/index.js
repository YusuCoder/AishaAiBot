import { config } from './config.js';
import { store } from './store.js';
import { allegro, authorizeDevice } from './allegro.js';
import { telegram, escapeHtml } from './telegram.js';

const chatId = config.telegram.chatId;

// ---------- Allegro → Telegram ----------

function formatBuyerMessage(thread, message, offerTitle) {
  const lines = [`💬 <b>${escapeHtml(thread.interlocutor?.login ?? 'Buyer')}</b> · Allegro`];
  const offerId = message.relatesTo?.offer?.id;
  const orderId = message.relatesTo?.order?.id;
  if (offerId) {
    const label = offerTitle ? escapeHtml(offerTitle) : `offer ${offerId}`;
    lines.push(`📦 <a href="https://allegro.pl/oferta/${offerId}">${label}</a>`);
  }
  if (orderId) lines.push(`🧾 Order <code>${orderId}</code>`);
  if (message.subject) lines.push(`<b>${escapeHtml(message.subject)}</b>`);
  lines.push('', escapeHtml(message.text || '(no text)'));
  if (message.attachments?.length) {
    lines.push('', `📎 ${message.attachments.map((a) => escapeHtml(a.fileName)).join(', ')} (open in Allegro)`);
  }
  lines.push('', '<i>↩️ Reply to this message to answer the buyer.</i>');
  return lines.join('\n');
}

async function checkAllegro() {
  const firstRun = !store.initialized;
  const threads = await allegro.listThreads();

  for (const thread of threads) {
    const lastSeen = store.lastSeen(thread.id);
    const lastSeenMs = lastSeen ? Date.parse(lastSeen) : null;
    if (lastSeenMs && Date.parse(thread.lastMessageDateTime) <= lastSeenMs) continue;

    const messages = await allegro.listMessages(thread.id);
    const newest = messages[0]?.createdAt ?? thread.lastMessageDateTime;

    // On the very first run don't flood Telegram with history — only forward unread threads.
    const fresh = messages
      .filter((m) => m.author?.isInterlocutor)
      .filter((m) => (lastSeenMs ? Date.parse(m.createdAt) > lastSeenMs : !firstRun || !thread.read))
      .reverse(); // oldest first

    for (const message of fresh) {
      const offerId = message.relatesTo?.offer?.id;
      const title = offerId ? await allegro.offerTitle(offerId) : null;
      const sent = await telegram.sendMessage(chatId, formatBuyerMessage(thread, message, title));
      store.linkTelegramMessage(sent.message_id, thread.id, thread.interlocutor?.login);
    }

    store.setLastSeen(thread.id, newest);
  }

  if (firstRun) store.markInitialized();
}

async function pollAllegro() {
  for (;;) {
    try {
      await checkAllegro();
    } catch (err) {
      console.error('Allegro polling error:', err.message);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

// ---------- Telegram → Allegro ----------

async function onTelegramMessage(msg) {
  if (msg.text === '/start' || msg.text === '/id') {
    const note = chatId === msg.chat.id ? '✅ This chat is connected.' : 'Put this id into TELEGRAM_CHAT_ID in .env and restart.';
    await telegram.sendMessage(msg.chat.id, `Your chat id: <code>${msg.chat.id}</code>\n${note}`);
    return;
  }
  if (msg.chat.id !== chatId) return; // ignore strangers

  const repliedTo = msg.reply_to_message?.message_id;
  const link = repliedTo && store.threadForTelegramMessage(repliedTo);
  if (!link) {
    await telegram.sendMessage(chatId, 'To answer a buyer, <b>reply</b> (swipe left) to their message.', {
      reply_parameters: { message_id: msg.message_id },
    });
    return;
  }
  if (!msg.text) {
    await telegram.sendMessage(chatId, 'Only text replies are supported for now.', {
      reply_parameters: { message_id: msg.message_id },
    });
    return;
  }

  try {
    await allegro.sendMessage(link.threadId, msg.text);
    await allegro.markThreadRead(link.threadId).catch(() => {});
    await telegram.sendMessage(chatId, `✅ Sent to <b>${escapeHtml(link.buyerLogin ?? 'buyer')}</b>`, {
      reply_parameters: { message_id: msg.message_id },
    });
  } catch (err) {
    console.error('Send to Allegro failed:', err.message);
    await telegram.sendMessage(chatId, `❌ Not sent: ${escapeHtml(err.message.slice(0, 500))}`, {
      reply_parameters: { message_id: msg.message_id },
    });
  }
}

// ---------- Start ----------

async function main() {
  telegram.listen(onTelegramMessage);

  if (!chatId) {
    console.log('TELEGRAM_CHAT_ID is empty. Send /start to your bot to get your chat id, put it in .env and restart.');
    return;
  }

  if (!store.tokens) {
    await authorizeDevice(async (url) => {
      console.log(`\nOpen this link and approve the app in Allegro:\n${url}\n`);
      await telegram.sendMessage(chatId, `🔐 Connect your Allegro account:\n${url}`);
    });
    await telegram.sendMessage(chatId, '✅ Allegro connected. New buyer messages will appear here.');
  }

  console.log('Running. Checking Allegro every', config.pollIntervalMs / 1000, 'seconds.');
  pollAllegro();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
