import { config } from './config.js';
import { store } from './store.js';
import { allegro, authorizeDevice } from './allegro.js';
import { telegram, escapeHtml } from './telegram.js';

const chatId = config.telegram.chatId;

// ---------- Allegro → Telegram ----------

function formatBuyerMessage(thread, message, offerTitle) {
  const lines = [`💬 <b>${escapeHtml(thread.interlocutor?.login ?? 'Покупатель')}</b> · Allegro`];
  const offerId = message.relatesTo?.offer?.id;
  const orderId = message.relatesTo?.order?.id;
  if (offerId) {
    const label = offerTitle ? escapeHtml(offerTitle) : `объявление ${offerId}`;
    lines.push(`📦 <a href="https://allegro.pl/oferta/${offerId}">${label}</a>`);
  }
  if (orderId) lines.push(`🧾 Заказ <code>${orderId}</code>`);
  if (message.subject) lines.push(`<b>${escapeHtml(message.subject)}</b>`);
  lines.push('', escapeHtml(message.text || '(без текста)'));
  if (message.attachments?.length) {
    lines.push('', `📎 ${message.attachments.map((a) => escapeHtml(a.fileName)).join(', ')} (откройте в Allegro)`);
  }
  lines.push('', '<i>↩️ Ответьте на это сообщение, чтобы написать покупателю.</i>');
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

function senderName(from) {
  if (!from) return '';
  return from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ');
}

async function onTelegramMessage(msg) {
  // In groups commands arrive as "/start@YourBot".
  const command = msg.text?.startsWith('/') ? msg.text.split(/[@\s]/)[0] : null;
  if (command === '/start' || command === '/id') {
    const note =
      chatId === msg.chat.id
        ? '✅ Этот чат подключён.'
        : 'Укажите этот id в TELEGRAM_CHAT_ID в файле .env и перезапустите бота.';
    await telegram.sendMessage(msg.chat.id, `ID вашего чата: <code>${msg.chat.id}</code>\n${note}`);
    return;
  }
  if (msg.chat.id !== chatId) return; // ignore strangers

  const repliedTo = msg.reply_to_message?.message_id;
  const link = repliedTo && store.threadForTelegramMessage(repliedTo);
  if (!link) {
    // In a group people also talk to each other — only hint in a private chat.
    if (msg.chat.type !== 'private') return;
    await telegram.sendMessage(chatId, 'Чтобы ответить покупателю, нажмите <b>«Ответить»</b> на его сообщение (свайп влево).', {
      reply_parameters: { message_id: msg.message_id },
    });
    return;
  }
  if (!msg.text) {
    await telegram.sendMessage(chatId, 'Пока можно отправлять только текстовые ответы.', {
      reply_parameters: { message_id: msg.message_id },
    });
    return;
  }

  try {
    await allegro.sendMessage(link.threadId, msg.text);
    await allegro.markThreadRead(link.threadId).catch(() => {});
    const by = msg.chat.type === 'private' ? '' : ` · ответил(а) ${escapeHtml(senderName(msg.from))}`;
    await telegram.sendMessage(chatId, `✅ Отправлено покупателю <b>${escapeHtml(link.buyerLogin ?? '')}</b>${by}`, {
      reply_parameters: { message_id: msg.message_id },
    });
  } catch (err) {
    console.error('Send to Allegro failed:', err.message);
    await telegram.sendMessage(chatId, `❌ Не отправлено: ${escapeHtml(err.message.slice(0, 500))}`, {
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
      await telegram.sendMessage(chatId, `🔐 Подключите аккаунт Allegro — откройте ссылку и подтвердите доступ:\n${url}`);
    });
    await telegram.sendMessage(chatId, '✅ Allegro подключён. Новые сообщения покупателей будут приходить сюда.');
  }

  console.log('Running. Checking Allegro every', config.pollIntervalMs / 1000, 'seconds.');
  pollAllegro();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
