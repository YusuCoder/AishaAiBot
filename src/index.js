import { config } from './config.js';
import { store } from './store.js';
import { allegro, authorizeDevice } from './allegro.js';
import { telegram, escapeHtml } from './telegram.js';
import { translationEnabled, translateForTeam, composeReply } from './translate.js';

const chatId = config.telegram.chatId;

// Forum mode: the chat is a group with Topics — one topic per Allegro conversation.
// Otherwise (private chat / plain group) the team answers by replying to the bot's message.
let forumMode = false;

const HISTORY_LIMIT = 10;
const NOTE_PREFIX = '//';
const RAW_PREFIX = '!'; // send exactly as typed, without translation

// ---------- Formatting ----------

const offerTitles = new Map();

async function offerTitle(offerId) {
  if (!offerId) return null;
  if (!offerTitles.has(offerId)) offerTitles.set(offerId, await allegro.offerTitle(offerId));
  return offerTitles.get(offerId);
}

function contextLines(message, title) {
  const lines = [];
  const offerId = message.relatesTo?.offer?.id;
  const orderId = message.relatesTo?.order?.id;
  if (offerId) {
    const label = title ? escapeHtml(title) : `объявление ${offerId}`;
    lines.push(`📦 <a href="https://allegro.pl/oferta/${offerId}">${label}</a>`);
  }
  if (orderId) lines.push(`🧾 Заказ <code>${orderId}</code>`);
  return lines;
}

const FLAGS = {
  Polish: '🇵🇱',
  Czech: '🇨🇿',
  Slovak: '🇸🇰',
  Hungarian: '🇭🇺',
  Ukrainian: '🇺🇦',
  English: '🇬🇧',
  German: '🇩🇪',
  Russian: '🇷🇺',
};
const flag = (language) => FLAGS[language] ?? '🌐';

function messageBody(message) {
  const lines = [];
  if (message.subject) lines.push(`<b>${escapeHtml(message.subject)}</b>`);
  lines.push(escapeHtml(message.text || '(без текста)'));
  if (message.attachments?.length) {
    lines.push(`📎 ${message.attachments.map((a) => escapeHtml(a.fileName)).join(', ')} (откройте в Allegro)`);
  }
  return lines.join('\n');
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('ru-RU', {
    timeZone: 'Europe/Warsaw',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function buyerLogin(thread) {
  return thread.interlocutor?.login ?? 'Покупатель';
}

// ---------- Translate button ----------

const TRANSLATE_BUTTON = { inline_keyboard: [[{ text: '🌐 Перевести', callback_data: 'tr' }]] };

/** Sends a message; when translation is on and there is text, adds a "Translate" button under it. */
async function sendTranslatable(threadId, html, plainText, extra = {}) {
  const withButton = translationEnabled && Boolean(plainText);
  const sent = await telegram.sendMessage(chatId, html, {
    ...extra,
    ...(withButton ? { reply_markup: TRANSLATE_BUTTON } : {}),
  });
  if (withButton) {
    store.setTranslatable(sent.message_id, { html, text: plainText, product: store.threadProduct(threadId) });
  }
  return sent;
}

const translating = new Set();

async function onCallback(query) {
  if (query.message?.chat.id !== chatId) return telegram.answerCallback(query.id);
  if (query.data === 'tr') return onTranslateClick(query);
  if (query.data === 'send' || query.data === 'cancel') return onDraftClick(query);
  return telegram.answerCallback(query.id);
}

async function onTranslateClick(query) {
  const messageId = query.message.message_id;
  if (translating.has(messageId)) {
    await telegram.answerCallback(query.id);
    return;
  }
  const item = store.translatable(messageId);
  if (!item) {
    await telegram.answerCallback(query.id, 'Уже переведено');
    return;
  }

  translating.add(messageId);
  try {
    const t = await translateForTeam(item.text, { product: item.product });
    const translation = t.isTeamLanguage
      ? '<i>Сообщение уже на вашем языке.</i>'
      : `${flag(config.openai.teamLanguage)} <i>${escapeHtml(t.translation)}</i>`;
    const edited = `${item.html}\n\n${translation}`;
    if (edited.length <= 4096) {
      // Editing without reply_markup also removes the button.
      await telegram.editMessageText(chatId, messageId, edited);
    } else {
      await telegram.editMessageText(chatId, messageId, item.html);
      await telegram.sendMessage(chatId, translation.slice(0, 4096), {
        ...(query.message.message_thread_id ? { message_thread_id: query.message.message_thread_id } : {}),
        reply_parameters: { message_id: messageId },
      });
    }
    store.forgetTranslatable(messageId);
    await telegram.answerCallback(query.id);
  } catch (err) {
    console.error('Translation failed:', err.message);
    await telegram.answerCallback(query.id, 'Не удалось перевести, попробуйте ещё раз');
  } finally {
    translating.delete(messageId);
  }
}

// ---------- Allegro → Telegram: reply mode ----------

async function forwardAsReplyable(thread, message) {
  const title = await offerTitle(message.relatesTo?.offer?.id);
  const text = [
    `💬 <b>${escapeHtml(buyerLogin(thread))}</b> · Allegro`,
    ...contextLines(message, title),
    '',
    messageBody(message),
    '',
    '<i>↩️ Ответьте на это сообщение, чтобы написать покупателю.</i>',
  ].join('\n');
  const sent = await sendTranslatable(thread.id, text, message.text);
  store.linkTelegramMessage(sent.message_id, thread.id, buyerLogin(thread));
}

// ---------- Allegro → Telegram: forum mode ----------

async function createTopic(thread, firstMessage, history) {
  const login = buyerLogin(thread);
  const title = await offerTitle(firstMessage.relatesTo?.offer?.id);
  const topic = await telegram.createForumTopic(chatId, title ? `${login} · ${title}` : login);
  const topicId = topic.message_thread_id;
  store.setTopic(thread.id, topicId, login);

  const intro = [`🛒 Покупатель: <b>${escapeHtml(login)}</b>`, ...contextLines(firstMessage, title), '', ...howToLines()];
  await telegram.sendMessage(chatId, intro.join('\n'), { message_thread_id: topicId });

  await sendHistory(
    thread.id,
    login,
    history.map((m) => ({ createdAt: m.createdAt, text: m.text, role: m.author?.isInterlocutor ? 'BUYER' : 'SELLER' })),
    topicId,
  );
  return topicId;
}

function howToLines() {
  return [
    '✍️ Всё, что вы напишете в этой теме, отправится покупателю в Allegro.',
    `💡 Начните сообщение с <code>${NOTE_PREFIX}</code> — это внутренняя заметка, покупатель её не увидит.`,
    ...(translationEnabled
      ? [
          `🤖 Пишите коротко и на своём языке — ИИ сделает из этого вежливый ответ на языке покупателя.`,
          `Перед отправкой вы увидите черновик с кнопками ✅ Отправить / ❌ Отмена.`,
          `Начните с <code>${RAW_PREFIX}</code>, чтобы сразу отправить текст как есть, без ИИ.`,
        ]
      : []),
  ];
}

/** Earlier messages of a conversation, as one message with a Translate button. */
async function sendHistory(key, login, history, topicId) {
  if (!history.length) return;
  const who = (role) => (role === 'BUYER' ? `👤 ${escapeHtml(login)}` : role === 'SELLER' ? '🏪 Вы' : '🛡 Allegro');
  const whoPlain = (role) => (role === 'BUYER' ? login : role === 'SELLER' ? 'Вы' : 'Allegro');
  let items = history.map((m) => ({
    html: `<i>${formatTime(m.createdAt)}</i> ${who(m.role)}: ${escapeHtml(m.text || '(без текста)')}`,
    plain: `${whoPlain(m.role)}: ${m.text || ''}`,
  }));
  // Leave room for the translation under it — drop the oldest lines rather than cutting HTML in half.
  const header = '🕘 <b>Предыдущие сообщения:</b>\n\n';
  while (items.length > 1 && (header + items.map((i) => i.html).join('\n\n')).length > 2000) items = items.slice(1);
  await sendTranslatable(
    key,
    header + items.map((i) => i.html).join('\n\n').slice(0, 4000),
    items.map((i) => i.plain).join('\n\n'),
    { message_thread_id: topicId },
  );
}

async function sendToTopic(thread, message, history, text) {
  const topicId = store.topicForThread(thread.id)?.topicId ?? (await createTopic(thread, message, history));
  try {
    await sendTranslatable(thread.id, text, message.text, { message_thread_id: topicId });
  } catch (err) {
    if (!/thread not found/i.test(err.message)) throw err;
    // Someone deleted the topic — start a new one.
    store.setTopic(thread.id, null);
    const newTopicId = await createTopic(thread, message, history);
    await sendTranslatable(thread.id, text, message.text, { message_thread_id: newTopicId });
  }
}

async function forwardToTopic(thread, message, history) {
  let text;
  if (message.author?.isInterlocutor) {
    const title = await offerTitle(message.relatesTo?.offer?.id);
    text = [`💬 ${messageBody(message)}`, ...contextLines(message, title)].join('\n');
  } else {
    // The seller answered on allegro.pl directly — mirror it so the topic has the full conversation.
    text = `📤 <i>Ответ с сайта Allegro:</i>\n${messageBody(message)}`;
  }
  await sendToTopic(thread, message, history, text);
}

// ---------- Polling ----------

/** Messages (oldest first) that haven't been delivered to Telegram yet. */
function pickNew(chrono, thread, lastSeenMs, firstRun) {
  if (lastSeenMs) return chrono.filter((m) => Date.parse(m.createdAt) > lastSeenMs);
  // On the very first run don't flood Telegram with history — only unread threads.
  if (firstRun && thread.read) return [];
  // A thread we haven't tracked yet: the buyer messages after our last answer.
  const lastOurs = chrono.findLastIndex((m) => !m.author?.isInterlocutor);
  return chrono.slice(lastOurs + 1);
}

async function checkAllegro() {
  const firstRun = !store.initialized;
  const threads = await allegro.listThreads();

  for (const thread of threads) {
    const lastSeen = store.lastSeen(thread.id);
    const lastSeenMs = lastSeen ? Date.parse(lastSeen) : null;
    if (lastSeenMs && Date.parse(thread.lastMessageDateTime) <= lastSeenMs) continue;

    const chrono = (await allegro.listMessages(thread.id)).reverse();
    const offerId = chrono.findLast((m) => m.relatesTo?.offer?.id)?.relatesTo.offer.id;
    if (offerId) store.setThreadProduct(thread.id, await offerTitle(offerId));
    const fresh = pickNew(chrono, thread, lastSeenMs, firstRun);
    const history = chrono.slice(0, chrono.length - fresh.length).slice(-HISTORY_LIMIT);

    for (const message of fresh) {
      if (forumMode) {
        if (message.author?.isInterlocutor || !store.sentByBot(message.id)) {
          await forwardToTopic(thread, message, history);
        }
      } else if (message.author?.isInterlocutor) {
        await forwardAsReplyable(thread, message);
      }
      store.setLastSeen(thread.id, message.createdAt);
    }

    store.setLastSeen(thread.id, chrono.at(-1)?.createdAt ?? thread.lastMessageDateTime);
  }

  if (firstRun) store.markInitialized();
}

// ---------- Disputes and complaints (Allegro "issues") ----------

const ISSUE_PREFIX = 'issue:';
const isIssue = (key) => key.startsWith(ISSUE_PREFIX);

const ISSUE_KINDS = {
  DISPUTE: { icon: '⚠️', name: 'Спор', ai: 'a dispute (discussion) the customer opened on Allegro' },
  CLAIM: { icon: '📋', name: 'Рекламация', ai: 'a complaint (reklamacja) the customer filed on Allegro' },
};
const issueKind = (type) => ISSUE_KINDS[type] ?? { icon: '⚠️', name: 'Обращение', ai: 'a post-purchase issue on Allegro' };

const ISSUE_STATUS = {
  DISPUTE_ONGOING: '🟠 открыт',
  DISPUTE_CLOSED: '🔒 закрыт',
  DISPUTE_UNRESOLVED: '🔴 не решён — подключился Allegro',
  CLAIM_SUBMITTED: '🟠 подана',
  CLAIM_ACCEPTED: '✅ принята',
  CLAIM_REJECTED: '❌ отклонена',
};
const issueStatus = (status) => ISSUE_STATUS[status] ?? status ?? '—';

function issueTopicName(meta) {
  const kind = issueKind(meta.type);
  return `${kind.icon} ${kind.name} · ${meta.login} · ${meta.subject ?? ''}`.slice(0, 128);
}

function issueHeaderLines(meta) {
  const kind = issueKind(meta.type);
  const product = store.threadProduct(meta.key);
  return [
    `${kind.icon} <b>${kind.name}</b>${meta.orderId ? ` по заказу <code>${meta.orderId}</code>` : ''}`,
    `🛒 Покупатель: <b>${escapeHtml(meta.login)}</b>`,
    ...(product ? [`📦 ${escapeHtml(product)}`] : []),
    ...(meta.subject ? [`❓ Причина: ${escapeHtml(meta.subject)}`] : []),
    `📌 Статус: ${issueStatus(meta.status)}${meta.dueDate ? ` · ⏰ срок: ${formatTime(meta.dueDate)}` : ''}`,
  ];
}

async function ensureIssueTopic(meta, history) {
  const existing = store.topicForThread(meta.key)?.topicId;
  if (existing) return existing;
  const topic = await telegram.createForumTopic(chatId, issueTopicName(meta));
  const topicId = topic.message_thread_id;
  store.setTopic(meta.key, topicId, meta.login);
  await telegram.sendMessage(chatId, [...issueHeaderLines(meta), '', ...howToLines()].join('\n'), {
    message_thread_id: topicId,
  });
  await sendHistory(meta.key, meta.login, history, topicId);
  return topicId;
}

/** Posts into the issue's topic (forum mode) or as a replyable message (reply mode). */
async function sendIssueUpdate(meta, history, html, plainText) {
  if (!forumMode) {
    const kind = issueKind(meta.type);
    const text = [
      `${kind.icon} <b>${kind.name}</b> · <b>${escapeHtml(meta.login)}</b> · ${escapeHtml(meta.subject ?? '')}`,
      '',
      html,
      '',
      '<i>↩️ Ответьте на это сообщение, чтобы написать покупателю.</i>',
    ].join('\n');
    const sent = await sendTranslatable(meta.key, text, plainText);
    store.linkTelegramMessage(sent.message_id, meta.key, meta.login);
    return;
  }
  for (let attempt = 1; ; attempt++) {
    const topicId = await ensureIssueTopic(meta, history);
    try {
      await sendTranslatable(meta.key, html, plainText, { message_thread_id: topicId });
      return;
    } catch (err) {
      if (attempt > 1 || !/thread not found/i.test(err.message)) throw err;
      store.setTopic(meta.key, null); // topic was deleted — make a new one
    }
  }
}

function issueMessageHtml(m) {
  const attachments = m.attachments?.length ? `\n📎 Вложений: ${m.attachments.length} (откройте в Allegro)` : '';
  const text = escapeHtml(m.text || '(без текста)');
  if (m.author?.role === 'BUYER') return `💬 ${text}${attachments}`;
  if (m.author?.role === 'SELLER') return `📤 <i>Ответ с сайта Allegro:</i>\n${text}${attachments}`;
  return `🛡 <b>Allegro:</b>\n${text}${attachments}`;
}

async function checkIssues() {
  const firstRun = !store.issuesInitialized;
  const issues = await allegro.listIssues();

  for (const issue of issues) {
    const key = ISSUE_PREFIX + issue.id;
    const known = store.issueMeta(key);
    const lastMessageAt = issue.chat?.lastMessage?.createdAt ?? null;
    const lastSeen = store.lastSeen(key);
    const lastSeenMs = lastSeen ? Date.parse(lastSeen) : null;
    const hasNew = Boolean(lastMessageAt) && (!lastSeenMs || Date.parse(lastMessageAt) > lastSeenMs);
    const status = issue.currentState?.status ?? null;
    const statusChanged = Boolean(known) && known.status !== status;
    if (known && !hasNew && !statusChanged) continue;

    if (!known && issue.checkoutForm?.id) {
      const order = await allegro.order(issue.checkoutForm.id);
      store.setThreadProduct(key, order?.lineItems?.[0]?.offer?.name);
    }
    const meta = {
      key,
      type: issue.type,
      subject: issue.subject,
      orderId: issue.checkoutForm?.id ?? null,
      login: issue.buyer?.login ?? 'Покупатель',
      status,
      // The due date only matters while the issue is open.
      dueDate: issue.currentState?.chatActive ? (issue.currentState?.statusDueDate ?? null) : null,
    };
    store.setIssueMeta(key, meta);

    // On the very first run only bring in open issues still waiting for our answer.
    const waitingForUs = issue.currentState?.chatActive && issue.chat?.lastMessage?.status !== 'SELLER_REPLIED';
    if (hasNew && (lastSeenMs || !firstRun || waitingForUs)) {
      const chat = await allegro.issueChat(issue.id);
      const lastOurs = chat.findLastIndex((m) => m.author?.role === 'SELLER');
      const fresh = lastSeenMs
        ? chat.filter((m) => Date.parse(m.createdAt) > lastSeenMs)
        : chat.slice(lastOurs + 1);
      const history = chat
        .slice(0, chat.length - fresh.length)
        .slice(-HISTORY_LIMIT)
        .map((m) => ({ createdAt: m.createdAt, text: m.text, role: m.author?.role }));

      for (const m of fresh) {
        const ours = m.author?.role === 'SELLER';
        if (!ours || (forumMode && !store.sentByBot(m.id))) {
          await sendIssueUpdate(meta, history, issueMessageHtml(m), m.text);
        }
        store.setLastSeen(key, m.createdAt);
      }
    }
    if (lastMessageAt) store.setLastSeen(key, lastMessageAt);

    if (statusChanged) {
      const html = `📌 <b>Статус изменён:</b> ${issueStatus(status)}${meta.dueDate ? ` · ⏰ срок: ${formatTime(meta.dueDate)}` : ''}`;
      if (!forumMode || store.topicForThread(key)) await sendIssueUpdate(meta, [], html, null);
    }
  }

  if (firstRun) store.markIssuesInitialized();
}

async function pollAllegro() {
  for (;;) {
    try {
      await checkAllegro();
    } catch (err) {
      console.error('Allegro polling error:', err.message);
    }
    try {
      await checkIssues();
    } catch (err) {
      console.error('Allegro issues polling error:', err.message);
    }
    await new Promise((r) => setTimeout(r, config.pollIntervalMs));
  }
}

// ---------- Telegram → Allegro ----------

function senderName(from) {
  if (!from) return '';
  return from.username ? `@${from.username}` : [from.first_name, from.last_name].filter(Boolean).join(' ');
}

/** Posts the team's reply to a message thread or an issue (dispute / complaint) chat. */
async function postToAllegro(key, text) {
  if (isIssue(key)) {
    const sent = await allegro.sendIssueMessage(key.slice(ISSUE_PREFIX.length), text);
    if (sent?.id) store.markSentByBot(sent.id);
    return;
  }
  const sent = await allegro.sendMessage(key, text);
  if (sent?.id) store.markSentByBot(sent.id);
  await allegro.markThreadRead(key).catch(() => {});
}

/** Recent conversation, the buyer's first name (from the order) and the situation, for the AI. */
async function replyContext(key) {
  const clip = (text) => text.slice(0, 1000);
  if (isIssue(key)) {
    const meta = store.issueMeta(key);
    const chat = (await allegro.issueChat(key.slice(ISSUE_PREFIX.length))).slice(-8);
    const product = store.threadProduct(key);
    return {
      conversation: chat
        .filter((m) => m.text)
        .map((m) => ({
          author: m.author?.role === 'BUYER' ? 'Customer' : m.author?.role === 'SELLER' ? 'Shop' : 'Allegro',
          text: clip(m.text),
        })),
      firstName: meta?.orderId ? await allegro.orderBuyerFirstName(meta.orderId) : null,
      situation: [
        `This is ${issueKind(meta?.type).ai}. Reason given: "${meta?.subject ?? 'unknown'}".`,
        ...(product ? [`Product: ${product}.`] : []),
        `Allegro staff may read this conversation: stay calm, factual and courteous.`,
      ].join(' '),
    };
  }
  const chrono = (await allegro.listMessages(key, 8)).reverse();
  const orderId = chrono.findLast((m) => m.relatesTo?.order?.id)?.relatesTo.order.id;
  return {
    conversation: chrono
      .filter((m) => m.text)
      .map((m) => ({ author: m.author?.isInterlocutor ? 'Customer' : 'Shop', text: clip(m.text) })),
    firstName: orderId ? await allegro.orderBuyerFirstName(orderId) : null,
  };
}

// ---------- AI drafts: preview → Send / Cancel ----------

const DRAFT_BUTTONS = {
  inline_keyboard: [
    [
      { text: '✅ Отправить', callback_data: 'send' },
      { text: '❌ Отмена', callback_data: 'cancel' },
    ],
  ],
};

function draftHtml(draft, status) {
  const lines = [status, '', `${flag(draft.language)} ${escapeHtml(draft.reply)}`];
  if (draft.language !== config.openai.teamLanguage) {
    lines.push('', `${flag(config.openai.teamLanguage)} <i>${escapeHtml(draft.teamVersion)}</i>`);
  }
  return lines.join('\n').slice(0, 4096);
}

async function showDraft(msg, link, extra) {
  const ai = await composeReply(msg.text, await replyContext(link.threadId));
  const draft = { ...ai, threadId: link.threadId, buyerLogin: link.buyerLogin };
  const preview = await telegram.sendMessage(chatId, draftHtml(draft, '📝 <b>Черновик ответа</b> — проверьте и отправьте:'), {
    ...extra,
    reply_markup: DRAFT_BUTTONS,
  });
  store.setDraft(preview.message_id, draft);
}

const handlingDraft = new Set();

async function onDraftClick(query) {
  const messageId = query.message.message_id;
  const draft = store.draft(messageId);
  if (!draft || handlingDraft.has(messageId)) {
    await telegram.answerCallback(query.id, draft ? undefined : 'Уже обработано');
    return;
  }

  handlingDraft.add(messageId);
  const who = escapeHtml(senderName(query.from));
  try {
    if (query.data === 'cancel') {
      store.forgetDraft(messageId);
      await telegram.editMessageText(chatId, messageId, draftHtml(draft, `❌ <b>Отменено</b> · ${who}`));
      await telegram.answerCallback(query.id);
      return;
    }
    await postToAllegro(draft.threadId, draft.reply);
    store.forgetDraft(messageId);
    const status = `✅ <b>Отправлено</b> покупателю <b>${escapeHtml(draft.buyerLogin ?? '')}</b> · ${who}`;
    await telegram.editMessageText(chatId, messageId, draftHtml(draft, status));
    await telegram.answerCallback(query.id, 'Отправлено');
  } catch (err) {
    console.error('Send to Allegro failed:', err.message);
    // Keep the draft and its buttons so it can be retried.
    await telegram.answerCallback(query.id, `Не отправлено: ${err.message}`.slice(0, 190));
  } finally {
    handlingDraft.delete(messageId);
  }
}

// ---------- Team messages ----------

function isMedia(msg) {
  return Boolean(msg.photo || msg.document || msg.video || msg.voice || msg.audio || msg.sticker || msg.video_note);
}

/**
 * A team member answered a buyer. With AI on, the note becomes a polished draft to approve;
 * "!" (or AI off) sends the text exactly as typed.
 */
async function handleTeamReply(msg, link, extra) {
  try {
    if (translationEnabled && !msg.text.startsWith(RAW_PREFIX)) {
      await showDraft(msg, link, extra);
      return;
    }
    const text = msg.text.startsWith(RAW_PREFIX) ? msg.text.slice(RAW_PREFIX.length).trim() : msg.text;
    await postToAllegro(link.threadId, text);
    if (forumMode) {
      await telegram.react(chatId, msg.message_id, '👍').catch(() => telegram.sendMessage(chatId, '✅ Отправлено', extra));
    } else {
      const by = msg.chat.type === 'private' ? '' : ` · ответил(а) ${escapeHtml(senderName(msg.from))}`;
      await telegram.sendMessage(chatId, `✅ Отправлено покупателю <b>${escapeHtml(link.buyerLogin ?? '')}</b>${by}`, extra);
    }
  } catch (err) {
    console.error('Team reply failed:', err.message);
    await telegram.sendMessage(chatId, `❌ Не отправлено: ${escapeHtml(err.message.slice(0, 500))}`, extra);
  }
}

async function onTopicMessage(msg) {
  if (!msg.is_topic_message || msg.from?.is_bot) return;
  const link = store.threadForTopic(msg.message_thread_id);
  if (!link) return;

  const inTopic = { message_thread_id: msg.message_thread_id, reply_parameters: { message_id: msg.message_id } };
  if (!msg.text) {
    if (isMedia(msg)) await telegram.sendMessage(chatId, 'Пока можно отправлять только текстовые ответы.', inTopic);
    return; // service messages (topic created, pinned…) have no text
  }
  if (msg.text.startsWith(NOTE_PREFIX)) return; // internal note

  await handleTeamReply(msg, link, inTopic);
}

async function onReplyMessage(msg) {
  const replyTo = { reply_parameters: { message_id: msg.message_id } };
  const repliedTo = msg.reply_to_message?.message_id;
  const link = repliedTo && store.threadForTelegramMessage(repliedTo);
  if (!link) {
    // In a group people also talk to each other — only hint in a private chat.
    if (msg.chat.type !== 'private') return;
    await telegram.sendMessage(chatId, 'Чтобы ответить покупателю, нажмите <b>«Ответить»</b> на его сообщение (свайп влево).', replyTo);
    return;
  }
  if (!msg.text) {
    await telegram.sendMessage(chatId, 'Пока можно отправлять только текстовые ответы.', replyTo);
    return;
  }

  await handleTeamReply(msg, link, replyTo);
}

async function onTelegramMessage(msg) {
  // In groups commands arrive as "/start@YourBot".
  const command = msg.text?.startsWith('/') ? msg.text.split(/[@\s]/)[0] : null;
  if (command === '/start' || command === '/id') {
    const note =
      chatId === msg.chat.id
        ? '✅ Этот чат подключён.'
        : 'Укажите этот id в TELEGRAM_CHAT_ID в файле .env и перезапустите бота.';
    await telegram.sendMessage(msg.chat.id, `ID вашего чата: <code>${msg.chat.id}</code>\n${note}`, {
      ...(msg.message_thread_id ? { message_thread_id: msg.message_thread_id } : {}),
    });
    return;
  }
  if (msg.chat.id !== chatId) return; // ignore strangers

  if (forumMode) await onTopicMessage(msg);
  else await onReplyMessage(msg);
}

// ---------- Start ----------

async function detectForumMode() {
  const chat = await telegram.getChat(chatId);
  forumMode = Boolean(chat.is_forum);
  if (!forumMode) return;

  const me = await telegram.getMyMember(chatId);
  if (me.status !== 'administrator' || !me.can_manage_topics) {
    console.warn('Bot is not an admin with "Manage topics" — it cannot create topics.');
    await telegram.sendMessage(
      chatId,
      '⚠️ Сделайте бота <b>администратором</b> группы с правом <b>«Управление темами»</b>, иначе он не сможет создавать темы для покупателей.',
    );
  }
}

async function main() {
  telegram.listen(onTelegramMessage, onCallback);

  if (!chatId) {
    console.log('TELEGRAM_CHAT_ID is empty. Send /start to your bot to get your chat id, put it in .env and restart.');
    return;
  }

  await detectForumMode();

  if (!store.tokens) {
    await authorizeDevice(async (url) => {
      console.log(`\nOpen this link and approve the app in Allegro:\n${url}\n`);
      await telegram.sendMessage(chatId, `🔐 Подключите аккаунт Allegro — откройте ссылку и подтвердите доступ:\n${url}`);
    });
    await telegram.sendMessage(chatId, '✅ Allegro подключён. Новые сообщения покупателей будут приходить сюда.');
  }

  console.log(
    `Running in ${forumMode ? 'topics' : 'reply'} mode, translation ${translationEnabled ? `on (${config.openai.model})` : 'off'}. Checking Allegro every ${config.pollIntervalMs / 1000} seconds.`,
  );
  pollAllegro();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
