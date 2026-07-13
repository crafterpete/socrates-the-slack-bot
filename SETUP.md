# Setup

Socrates is a Slack Q&A bot grounded in a SQLite database. It runs in Socket Mode, so it needs no public URL: any machine that can reach Slack and the model APIs can run it.

## Quickstart

```bash
git clone <this repo> && cd langchain-slack-bot
npm install
cp .env.example .env   # fill in the four keys below
npm run dev
```

Mention the bot in a channel it's been added to and ask it something. The database fixture (`src/db/synthetic_startup.sqlite`) and the prebuilt embedding index ship with the repo, so no seeding is needed for a first run.

## API keys

Two different providers, two different jobs:

- **`ANTHROPIC_API_KEY`** powers the runtime: the Q&A agent, thread summarization, and the input classifier.
- **`OPENAI_API_KEY`** is used only for embeddings (semantic search over artifacts). It's needed at runtime to embed incoming queries, and by `npm run db:build-embeddings` to build the index.

If a provided/shared key has expired, swap in your own from console.anthropic.com and platform.openai.com respectively; nothing else changes.

## Slack app configuration

Create an app at [api.slack.com/apps](https://api.slack.com/apps), then:

1. **Socket Mode** (Settings → Socket Mode): enable it and generate an app-level token with `connections:write`. This is your `SLACK_APP_TOKEN` (`xapp-...`).

2. **Event subscriptions** (Features → Event Subscriptions → Subscribe to bot events):

   | Event | Why the bot needs it |
   |---|---|
   | `app_mention` | Answer questions when @-mentioned |
   | `message.channels` | Capture thread replies in public channels as context |
   | `message.groups` | Same, private channels |
   | `message.im` | Same, DMs |
   | `reaction_added` | Record 👍/👎 on answers as feedback |
   | `reaction_removed` | Retract that feedback |

3. **Bot token scopes** (Features → OAuth & Permissions): `app_mentions:read`, `channels:history`, `chat:write`, `chat:write.public`, `emoji:read`, `groups:history`, `im:history`, `reactions:read`, `reactions:write`, `search:read.public`.

4. **Install** the app to your workspace. The Bot User OAuth Token is your `SLACK_BOT_TOKEN` (`xoxb-...`). Re-install whenever you add scopes; adding event subscriptions only needs a save.

Heads up: the reaction events in step 2 are easy to miss. Having `reactions:read` is not enough; without the subscriptions Slack never sends the events and the feedback table stays silently empty.

## Rebuilding the embedding index

The semantic-search index (`src/db/artifact_embeddings.bin` + manifest) is committed, but it's derived from the database. Rebuild it whenever the artifacts change or you switch `EMBEDDING_MODEL`:

```bash
npm run db:build-embeddings
```

If the index and database drift out of sync, the app refuses to serve stale results and tells you to run exactly this command.

## Verify it works

1. `npm run dev`, then mention the bot: it should react 👀, post a "thinking" line, and edit it into an answer.
2. React 👍 or 👎 on the answer. The console logs `Feedback: up on ...` (or a `Reaction ignored ...` line explaining why not). Feedback lands in the `feedback` table of `data/state.sqlite`.
3. `npm test` runs the unit suite; `npm run eval` runs the eval suite against the live model (see EVALS.md).
