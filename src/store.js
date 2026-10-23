// Tiny JSON-file state: Allegro tokens, last seen message per thread,
// and which Telegram message belongs to which Allegro thread.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';

const DIR = new URL('../data/', import.meta.url);
const FILE = new URL('state.json', DIR);

const MAX_LINKS = 2000;

let state = { tokens: null, threads: {}, links: {}, initialized: false };

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
};
