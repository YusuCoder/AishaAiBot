// Tiny JSON-file state: Allegro tokens, last seen message per thread,
// and which Telegram message belongs to which Allegro thread.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';

const DIR = new URL('../data/', import.meta.url);
const FILE = new URL('state.json', DIR);

const MAX_LINKS = 2000;
const MAX_SENT_IDS = 1000;

let state = { tokens: null, threads: {}, links: {}, topics: {}, sentIds: [], initialized: false };

try {
  state = { ...state, ...JSON.parse(readFileSync(FILE, 'utf8')) };
} catch {
  // first run
}

function save() {
  mkdirSync(DIR, { recursive: true });
  const tmp = new URL('state.json.tmp', DIR);
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, FILE);
}

export const store = {
  get tokens() {
    return state.tokens;
  },
  setTokens(tokens) {
    state.tokens = tokens;
    save();
  },

  get initialized() {
    return state.initialized;
  },
  markInitialized() {
    state.initialized = true;
    save();
  },

  /** ISO time of the newest message we've already handled in this thread. */
  lastSeen(threadId) {
    return state.threads[threadId] ?? null;
  },
  setLastSeen(threadId, isoTime) {
    state.threads[threadId] = isoTime;
    save();
  },

  linkTelegramMessage(telegramMessageId, threadId, buyerLogin) {
    state.links[telegramMessageId] = { threadId, buyerLogin };
    const keys = Object.keys(state.links);
    if (keys.length > MAX_LINKS) {
      for (const key of keys.slice(0, keys.length - MAX_LINKS)) delete state.links[key];
    }
    save();
  },
  threadForTelegramMessage(telegramMessageId) {
    return state.links[telegramMessageId] ?? null;
  },

  // Forum mode: one Telegram topic per Allegro thread.
  topicForThread(threadId) {
    return state.topics[threadId] ?? null;
  },
  setTopic(threadId, topicId, buyerLogin) {
    if (topicId == null) delete state.topics[threadId];
    else state.topics[threadId] = { topicId, buyerLogin };
    save();
  },
  threadForTopic(topicId) {
    for (const [threadId, topic] of Object.entries(state.topics)) {
      if (topic.topicId === topicId) return { threadId, buyerLogin: topic.buyerLogin };
    }
    return null;
  },

  // Offer title each conversation is about — context for translations (typos, product terms).
  threadProduct(threadId) {
    return state.products?.[threadId] ?? null;
  },
  setThreadProduct(threadId, title) {
    if (!title || state.products?.[threadId] === title) return;
    state.products = { ...state.products, [threadId]: title };
    save();
  },

  // AI-written replies waiting for "Send" / "Cancel", keyed by the preview message id.
  setDraft(previewMessageId, draft) {
    state.drafts = { ...state.drafts, [previewMessageId]: draft };
    save();
  },
  draft(previewMessageId) {
    return state.drafts?.[previewMessageId] ?? null;
  },
  forgetDraft(previewMessageId) {
    delete state.drafts?.[previewMessageId];
    save();
  },

  // Telegram messages with a "Translate" button: what to translate and how to redraw them.
  setTranslatable(telegramMessageId, item) {
    state.translatables = { ...state.translatables, [telegramMessageId]: item };
    const keys = Object.keys(state.translatables);
    if (keys.length > MAX_LINKS) {
      for (const key of keys.slice(0, keys.length - MAX_LINKS)) delete state.translatables[key];
    }
    save();
  },
  translatable(telegramMessageId) {
    return state.translatables?.[telegramMessageId] ?? null;
  },
  forgetTranslatable(telegramMessageId) {
    delete state.translatables?.[telegramMessageId];
    save();
  },

  // Allegro message ids we sent from Telegram, so we don't echo them back.
  markSentByBot(messageId) {
    state.sentIds.push(messageId);
    if (state.sentIds.length > MAX_SENT_IDS) state.sentIds.splice(0, state.sentIds.length - MAX_SENT_IDS);
    save();
  },
  sentByBot(messageId) {
    return state.sentIds.includes(messageId);
  },
};
