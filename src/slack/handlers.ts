import type { App } from "@slack/bolt";
import { requestConfig } from "../agent/gateway.js";
import { askAgent, createQaAgent } from "../agent/index.js";
import { maybeCompactThread } from "../memory/compaction.js";
import { appendThreadMessage, getThreadState, toAgentMessages } from "../memory/thread-store.js";

const agent = createQaAgent();

function stripBotMention(text: string): string {
  return text.replace(/^<@[^>]+>\s*/, "").trim();
}

async function handleUserQuestion(args: {
  channel: string;
  threadTs?: string;
  userId: string;
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
  const { channel, threadTs, userId, userText, say, client, messageTs } = args;
  // A top-level mention has no thread_ts yet, but our reply creates a thread rooted at the
  // triggering message — so that message's ts is the conversation key follow-ups will carry.
  const conversationTs = threadTs ?? messageTs;
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
    const history = toAgentMessages(getThreadState(channel, conversationTs));
    const messages = [...history, { role: "user" as const, content: question }];
    const answer = await askAgent(
      agent,
      messages,
      requestConfig({ userId, channel, threadTs: conversationTs }),
    );

    appendThreadMessage(channel, conversationTs, { role: "user", content: question });
    appendThreadMessage(channel, conversationTs, { role: "assistant", content: answer });

    await say({ text: answer, thread_ts: conversationTs });

    maybeCompactThread(channel, conversationTs).catch((error) => {
      console.error("Thread compaction failed:", error);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    await say({
      text: `Sorry, something went wrong while answering that: ${message}`,
      thread_ts: conversationTs,
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
      userId: event.user ?? "unknown",
      userText: event.text,
      say,
      client,
      messageTs: event.ts,
    });
  });

  app.message(async ({ message, say, client }) => {
    if (message.subtype || !("text" in message) || !message.text || !message.user) {
      return;
    }

    // Continue multi-turn conversations inside an existing thread.
    if (!message.thread_ts || message.thread_ts === message.ts) {
      return;
    }

    await handleUserQuestion({
      channel: message.channel,
      threadTs: message.thread_ts,
      userId: message.user,
      userText: message.text,
      say,
      client,
      messageTs: message.ts,
    });
  });
}
