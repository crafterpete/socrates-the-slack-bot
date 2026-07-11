import type { App } from "@slack/bolt";
import { askAgent, createQaAgent } from "../agent/index.js";
import { appendThreadMessage, getThreadHistory } from "../memory/thread-store.js";

const agent = createQaAgent();

function stripBotMention(text: string): string {
  return text.replace(/^<@[^>]+>\s*/, "").trim();
}

async function handleUserQuestion(args: {
  channel: string;
  threadTs?: string;
  userText: string;
  say: (message: { text: string; thread_ts?: string }) => Promise<unknown>;
  client: {
    reactions: {
      add: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
      remove: (args: { channel: string; timestamp: string; name: string }) => Promise<unknown>;
    };
  };
  messageTs: string;
}): Promise<void> {
  const { channel, threadTs, userText, say, client, messageTs } = args;
  const question = stripBotMention(userText);

  if (!question) {
    await say({
      text: "Ask me a question about customers, implementations, or internal records in the database.",
      thread_ts: threadTs,
    });
    return;
  }

  await client.reactions.add({ channel, timestamp: messageTs, name: "eyes" });

  try {
    const history = getThreadHistory(channel, threadTs);
    const messages = [...history, { role: "user" as const, content: question }];
    const answer = await askAgent(agent, messages);

    appendThreadMessage(channel, threadTs, { role: "user", content: question });
    appendThreadMessage(channel, threadTs, { role: "assistant", content: answer });

    await say({ text: answer, thread_ts: threadTs ?? messageTs });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await say({
      text: `Sorry, something went wrong while answering that: ${message}`,
      thread_ts: threadTs ?? messageTs,
    });
  } finally {
    await client.reactions.remove({ channel, timestamp: messageTs, name: "eyes" }).catch(() => undefined);
  }
}

export function registerSlackHandlers(app: App): void {
  app.event("app_mention", async ({ event, say, client }) => {
    await handleUserQuestion({
      channel: event.channel,
      threadTs: event.thread_ts,
      userText: event.text,
      say,
      client,
      messageTs: event.ts,
    });
  });

  app.message(async ({ message, say, client }) => {
    if (message.subtype || !("text" in message) || !message.text) {
      return;
    }

    // Continue multi-turn conversations inside an existing thread.
    if (!message.thread_ts || message.thread_ts === message.ts) {
      return;
    }

    await handleUserQuestion({
      channel: message.channel,
      threadTs: message.thread_ts,
      userText: message.text,
      say,
      client,
      messageTs: message.ts,
    });
  });
}
