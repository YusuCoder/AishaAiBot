# AishaAiBot — Allegro ↔ Telegram seller assistant

AishaAiBot is a private tool that helps an Allegro seller answer buyers faster.
It forwards new buyer messages from Allegro to the seller's Telegram, and sends the
seller's Telegram replies back to the same Allegro conversation.

It is built for, and used by, a **single seller account** (its owner). It is not a
public service and does not access any other Allegro accounts.

## What it does

1. Every 30 seconds it checks the seller's Allegro message center for new buyer messages
   (`GET /messaging/threads`, `GET /messaging/threads/{id}/messages`).
2. Each new message is sent to the seller's private Telegram chat with the buyer's login,
   the related offer (title and link) and order number, if any.
3. When the seller **replies** to that Telegram message, the reply is posted to the same
   Allegro thread (`POST /messaging/threads/{id}/messages`) and the thread is marked as read.

```
Buyer ──► Allegro messages ──► AishaAiBot ──► Seller's Telegram
Buyer ◄── Allegro messages ◄── AishaAiBot ◄── Seller's reply
```

### Planned

- AI-drafted reply suggestions in Polish, which the seller approves before sending
- Order, dispute and rating notifications
- Daily sales summary in Telegram

## Allegro API usage

| | |
|---|---|
| OAuth flow | Device flow (`device_code`), used by the account owner only |
| Main scopes | `allegro:api:messaging`, `allegro:api:sale:offers:read` |
| Polling | One threads request every 30 s, plus message/offer requests only for threads with new activity |
| User-Agent | Every request sends the User-Agent generated in the Allegro Developer Portal |

Tokens are refreshed automatically and stored only on the machine running the bot.

## Requirements

- Node.js 20.6 or newer (no npm dependencies)
- Optional: an OpenAI API key for translation
- An Allegro app registered at [apps.developer.allegro.pl](https://apps.developer.allegro.pl)
  with the **device_code** app type
- A Telegram bot token from [@BotFather](https://t.me/BotFather)

## Setup

```bash
git clone <this repo>
cd allegro-bot
cp .env.example .env   # fill in the values, see below
npm start
```

| Variable | Description |
|---|---|
| `ALLEGRO_CLIENT_ID` | Client ID of the Allegro app |
| `ALLEGRO_CLIENT_SECRET` | Client Secret of the Allegro app |
| `ALLEGRO_USER_AGENT` | User-Agent value generated in the Allegro Developer Portal |
| `ALLEGRO_ENV` | `production` or `sandbox` |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_CHAT_ID` | Seller's Telegram chat id. Leave empty, send `/start` to the bot and it will reply with the id |
| `OPENAI_API_KEY` | Optional. Enables translation |
| `OPENAI_MODEL` | OpenAI model for translation, default `gpt-5-mini` |
| `OPENAI_REASONING_EFFORT` | `minimal` for gpt-5 models; leave empty for non-reasoning models |
| `TEAM_LANGUAGE` | Language the team reads and writes, default `Russian` |
| `POLL_INTERVAL_SEC` | How often to check Allegro, default `30` |

On the first start the bot sends an Allegro authorization link to Telegram (and prints it
in the terminal). Open it, log in to Allegro and approve the app.

## Usage

The bot works in one of two modes, picked automatically from the chat in `TELEGRAM_CHAT_ID`.

### Group with Topics (recommended for teams)

Each Allegro conversation gets its own topic, so long conversations stay together.

- A new conversation creates a topic named `buyer · offer title`, with the last messages as history.
- Every new buyer message is posted in that topic; the topic moves to the top with an unread badge.
- **Anything the team writes in the topic is sent to the buyer.** The bot confirms with 👍.
- Messages starting with `//` are internal notes and are not sent.
- Replies the seller sends directly on allegro.pl are mirrored into the topic as well.

Setup: create a Telegram group, enable **Topics** in its settings, add the bot as an
**admin with "Manage topics"**, send `/start` in the group and put the id it shows into
`TELEGRAM_CHAT_ID`.

### Translation (optional)

With `OPENAI_API_KEY` set, the team can work in its own language (`TEAM_LANGUAGE`, default Russian):

- Buyer messages arrive in the original language with a **🌐 Перевести** button.
  Pressing it adds the translation under the message (translation is only paid for on demand).
- Team replies are translated into the language the buyer writes in (Polish by default)
  before sending. The bot shows the team exactly what the buyer received.
- Start a reply with `!` to send it exactly as typed, without translation.

### Private chat or plain group

- New buyer messages appear in the chat.
- To answer, **reply** to the buyer's message (swipe left on mobile).
  The bot confirms with "✅" or shows the error.

`/start` or `/id` shows the current Telegram chat id. The bot only responds to the chat
set in `TELEGRAM_CHAT_ID` and ignores everyone else.

## Data and privacy

- Allegro tokens, the last-seen time per thread, and a map of Telegram message → Allegro
  thread are stored locally in `data/state.json`. Nothing is sent anywhere except Allegro
  and Telegram, and, only when translation is enabled, the message text to the OpenAI API
  for translation.
- Buyer messages are delivered only to the seller's own Telegram chat and are not stored
  by the bot.
- `.env` and `data/` are excluded from git.

To disconnect, stop the bot and delete `data/state.json`, or revoke the app's access in
Allegro account settings.

## Contact

For questions about this application, please open an issue in this repository.
