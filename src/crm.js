// Connects the bot to the web CRM. The bot stays the only program talking to Allegro, because a
// second one would invalidate its login. It copies conversations to Supabase, then carries out
// what staff ask for there: AI drafts, approved replies and translations.
import { config } from './config.js';
import { allegro } from './allegro.js';
import { composeReply, translateForTeam, translationEnabled } from './translate.js';

const { url, serviceKey } = config.supabase;
const ISSUE_PREFIX = 'issue:';
const QUEUE_INTERVAL_MS = 3000;
const AUTHORS = { BUYER: 'buyer', SELLER: 'seller' };

export const crmEnabled = Boolean(url && serviceKey);

async function db(method, path, body, prefer) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Supabase ${method} ${path} → ${res.status}: ${await res.text()}`);
  return res.status === 204 ? null : res.json().catch(() => null);
}

const upsertConversation = (row) =>
  db('POST', 'conversations?on_conflict=id', row, 'resolution=merge-duplicates,return=minimal');

// ignore-duplicates keeps translations already stored on existing messages.
const insertMessages = (rows) =>
  rows.length
    ? db('POST', 'conversation_messages?on_conflict=id', rows, 'resolution=ignore-duplicates,return=minimal')
    : null;

const summary = (messages) => {
  const last = messages.at(-1);
  return {
    last_message_at: last?.sent_at ?? null,
    last_message_preview: last?.body.slice(0, 160) ?? null,
    last_from_buyer: last?.author === 'buyer',
  };
};

// ---------- Copy from Allegro ----------

async function storeThread(thread, known) {
  const allegroMessages = (await allegro.listMessages(thread.id)).reverse();
  const messages = allegroMessages.map((m) => ({
    id: m.id,
    conversation_id: thread.id,
    author: m.author?.isInterlocutor ? 'buyer' : 'seller',
    body: m.text ?? '',
    attachments: (m.attachments ?? []).map((a) => a.fileName),
    sent_at: m.createdAt,
  }));

  const offerId = allegroMessages.findLast((m) => m.relatesTo?.offer?.id)?.relatesTo.offer.id;
  const orderId = allegroMessages.findLast((m) => m.relatesTo?.order?.id)?.relatesTo.order.id;
  const newestAt = Date.parse(messages.at(-1)?.sent_at ?? 0);
  const newFromBuyer = messages.some((m) => m.author === 'buyer' && Date.parse(m.sent_at) > known);

  await upsertConversation({
    id: thread.id,
    kind: 'message',
    buyer_login: thread.interlocutor?.login ?? 'Buyer',
    ...(offerId ? { offer_id: offerId, offer_title: await allegro.offerTitle(offerId) } : {}),
    ...(orderId ? { order_id: orderId } : {}),
    ...summary(messages),
    // First copy: trust Allegro's unread flag rather than marking old history as new.
    ...(known ? (newFromBuyer ? { is_unread: true } : {}) : { is_unread: !thread.read && newestAt > 0 }),
  });
  await insertMessages(messages);
}

async function storeIssue(issue, isNew) {
  const id = ISSUE_PREFIX + issue.id;
  const chat = await allegro.issueChat(issue.id);
  const messages = chat.map((m) => ({
    id: m.id,
    conversation_id: id,
    author: AUTHORS[m.author?.role] ?? 'allegro',
    body: m.text ?? '',
    attachments: (m.attachments ?? []).map((a) => a.fileName ?? 'attachment'),
    sent_at: m.createdAt,
  }));

  const order = isNew && issue.checkoutForm?.id ? await allegro.order(issue.checkoutForm.id) : null;
  const unread = !['SELLER_REPLIED'].includes(issue.chat?.lastMessage?.status) && issue.currentState?.chatActive;

  await upsertConversation({
    id,
    kind: issue.type === 'CLAIM' ? 'complaint' : 'dispute',
    buyer_login: issue.buyer?.login ?? 'Buyer',
    subject: issue.subject,
    order_id: issue.checkoutForm?.id ?? null,
    status: issue.currentState?.status ?? null,
    due_date: issue.currentState?.chatActive ? (issue.currentState?.statusDueDate ?? null) : null,
    ...(order?.lineItems?.[0] ? { offer_title: order.lineItems[0].offer?.name, offer_id: order.lineItems[0].offer?.id } : {}),
    ...summary(messages),
    is_unread: Boolean(unread),
  });
  await insertMessages(messages);
}

async function syncConversations() {
  const rows = await db('GET', 'conversations?select=id,last_message_at,status');
  const known = new Map(rows.map((row) => [row.id, row]));

  for (const thread of await allegro.listThreads()) {
    const row = known.get(thread.id);
    const seenAt = row?.last_message_at ? Date.parse(row.last_message_at) : 0;
    if (!row || Date.parse(thread.lastMessageDateTime) > seenAt) await storeThread(thread, seenAt);
  }

  for (const issue of await allegro.listIssues()) {
    const row = known.get(ISSUE_PREFIX + issue.id);
    const lastAt = issue.chat?.lastMessage?.createdAt;
    const changed =
      !row ||
      row.status !== (issue.currentState?.status ?? null) ||
      (lastAt && Date.parse(lastAt) > Date.parse(row.last_message_at ?? 0));
    if (changed) await storeIssue(issue, !row);
  }
}

// ---------- Carry out what staff asked for ----------

async function refreshConversation(id) {
  if (id.startsWith(ISSUE_PREFIX)) {
    const issue = (await allegro.listIssues()).find((item) => ISSUE_PREFIX + item.id === id);
    if (issue) await storeIssue(issue, false);
    return;
  }
  const thread = (await allegro.listThreads()).find((item) => item.id === id);
  if (thread) await storeThread(thread, Date.now());
}

const updateOutbox = (id, changes, onlyIfStatus) =>
  db(
    'PATCH',
    `conversation_outbox?id=eq.${id}${onlyIfStatus ? `&status=eq.${onlyIfStatus}` : ''}`,
    changes,
    'return=representation',
  );

async function draftReply(item) {
  try {
    if (!translationEnabled) {
      await updateOutbox(item.id, { status: 'draft', draft: item.input });
      return;
    }
    const [conversation] = await db('GET', `conversations?id=eq.${encodeURIComponent(item.conversation_id)}&select=*`);
    const recent = await db(
      'GET',
      `conversation_messages?conversation_id=eq.${encodeURIComponent(item.conversation_id)}&select=author,body&order=sent_at.desc&limit=8`,
    );
    const names = { buyer: 'Customer', seller: 'Shop', allegro: 'Allegro' };
    const reply = await composeReply(item.input, {
      conversation: recent.reverse().filter((m) => m.body).map((m) => ({ author: names[m.author], text: m.body.slice(0, 1000) })),
      firstName: conversation.order_id ? await allegro.orderBuyerFirstName(conversation.order_id) : null,
      situation:
        conversation.kind === 'message'
          ? undefined
          : `This is a ${conversation.kind} the customer opened on Allegro. Reason given: "${conversation.subject ?? 'unknown'}". ` +
            `${conversation.offer_title ? `Product: ${conversation.offer_title}. ` : ''}` +
            `Allegro staff may read this conversation: stay calm, factual and courteous.`,
    });
    await updateOutbox(item.id, {
      status: 'draft',
      draft: reply.reply,
      draft_language: reply.language,
      draft_team_version: reply.teamVersion,
    });
  } catch (err) {
    console.error('CRM draft failed:', err.message);
    await updateOutbox(item.id, { status: 'failed', error: 'The reply could not be drafted.' });
  }
}

async function sendReply(item) {
  // Claiming first means a second pass can never send the same reply twice.
  const claimed = await updateOutbox(item.id, { status: 'sending' }, 'approved');
  if (!claimed?.length) return;

  try {
    if (item.conversation_id.startsWith(ISSUE_PREFIX)) {
      await allegro.sendIssueMessage(item.conversation_id.slice(ISSUE_PREFIX.length), item.draft);
    } else {
      await allegro.sendMessage(item.conversation_id, item.draft);
      await allegro.markThreadRead(item.conversation_id).catch(() => {});
    }
  } catch (err) {
    console.error('CRM send failed:', err.message);
    await updateOutbox(item.id, { status: 'failed', error: 'Allegro did not accept this reply.' });
    return;
  }

  await updateOutbox(item.id, { status: 'sent' });
  await refreshConversation(item.conversation_id).catch((err) => console.error('CRM refresh failed:', err.message));
}

async function translateRequested() {
  const rows = await db(
    'GET',
    'conversation_messages?translation_requested=eq.true&select=id,body,conversation_id&limit=10',
  );
  for (const row of rows) {
    const changes = { translation_requested: false };
    try {
      const [conversation] = await db('GET', `conversations?id=eq.${encodeURIComponent(row.conversation_id)}&select=offer_title`);
      const result = await translateForTeam(row.body, { product: conversation?.offer_title });
      changes.translation = result.isTeamLanguage ? row.body : result.translation;
    } catch (err) {
      console.error('CRM translation failed:', err.message);
    }
    await db('PATCH', `conversation_messages?id=eq.${encodeURIComponent(row.id)}`, changes, 'return=minimal');
  }
}

async function processQueue() {
  const items = await db('GET', 'conversation_outbox?status=in.(composing,approved)&select=*&order=created_at');
  for (const item of items) {
    if (item.status === 'composing') await draftReply(item);
    else await sendReply(item);
  }
  await translateRequested();
}

async function loop(task, name, intervalMs) {
  for (;;) {
    try {
      await task();
    } catch (err) {
      console.error(`CRM ${name} error:`, err.message);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export function startCrm() {
  console.log('CRM connection on.');
  loop(syncConversations, 'sync', config.pollIntervalMs);
  loop(processQueue, 'queue', QUEUE_INTERVAL_MS);
}
