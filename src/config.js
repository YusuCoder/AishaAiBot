function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing ${name} in .env (see .env.example)`);
    process.exit(1);
  }
  return value;
}

const sandbox = process.env.ALLEGRO_ENV === 'sandbox';

export const config = {
  allegro: {
    clientId: required('ALLEGRO_CLIENT_ID'),
    clientSecret: required('ALLEGRO_CLIENT_SECRET'),
    // Mandatory on every request — Allegro blocks the key without a valid one.
    userAgent: required('ALLEGRO_USER_AGENT'),
    authUrl: sandbox ? 'https://allegro.pl.allegrosandbox.pl/auth/oauth' : 'https://allegro.pl/auth/oauth',
    apiUrl: sandbox ? 'https://api.allegro.pl.allegrosandbox.pl' : 'https://api.allegro.pl',
  },
  telegram: {
    token: required('TELEGRAM_BOT_TOKEN'),
    chatId: process.env.TELEGRAM_CHAT_ID ? Number(process.env.TELEGRAM_CHAT_ID) : null,
  },
  // Optional: without a key the bot works as before, just without translation.
  openai: {
    apiKey: process.env.OPENAI_API_KEY || null,
    model: process.env.OPENAI_MODEL || 'gpt-5-mini',
    reasoningEffort: process.env.OPENAI_REASONING_EFFORT ?? 'minimal',
    teamLanguage: process.env.TEAM_LANGUAGE || 'Russian',
  },
  pollIntervalMs: Number(process.env.POLL_INTERVAL_SEC || 30) * 1000,
};
