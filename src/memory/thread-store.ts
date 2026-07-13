import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import type { ChatMessage } from "../shared/chat.js";

export type { ChatMessage };

export type StoredMessage = ChatMessage & { id: number };

export type ThreadState = {
  summary: string | undefined;
  messages: StoredMessage[];
};

let db: Database.Database | undefined;

function getStateDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(path.dirname(env.stateDatabasePath), { recursive: true });
    db = new Database(env.stateDatabasePath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS thread_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_key TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS thread_messages_by_key ON thread_messages(thread_key, id);
      CREATE TABLE IF NOT EXISTS thread_summaries (
        thread_key TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
    `);
  }
  return db;
}

function threadKey(channelId: string, threadTs?: string): string {
  return threadTs ? `${channelId}:${threadTs}` : channelId;
}

export function getThreadState(channelId: string, threadTs?: string): ThreadState {
  const store = getStateDb();
  const key = threadKey(channelId, threadTs);
  const summaryRow = store
    .prepare("SELECT summary FROM thread_summaries WHERE thread_key = ?")
    .get(key) as { summary: string } | undefined;
  const messages = store
    .prepare("SELECT id, role, content FROM thread_messages WHERE thread_key = ? ORDER BY id")
    .all(key) as StoredMessage[];
  return { summary: summaryRow?.summary, messages };
}

export function appendThreadMessage(
  channelId: string,
  threadTs: string | undefined,
  message: ChatMessage,
): void {
  getStateDb()
    .prepare("INSERT INTO thread_messages (thread_key, role, content) VALUES (?, ?, ?)")
    .run(threadKey(channelId, threadTs), message.role, message.content);
}

export function compactThread(
  channelId: string,
  threadTs: string | undefined,
  args: { summary: string; throughId: number },
): void {
  const store = getStateDb();
  const key = threadKey(channelId, threadTs);
  store.transaction(() => {
    store
      .prepare(
        `INSERT INTO thread_summaries (thread_key, summary, updated_at)
         VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         ON CONFLICT(thread_key) DO UPDATE SET
           summary = excluded.summary,
           updated_at = excluded.updated_at`,
      )
      .run(key, args.summary);
    store
      .prepare("DELETE FROM thread_messages WHERE thread_key = ? AND id <= ?")
      .run(key, args.throughId);
  })();
}

export function toAgentMessages(state: ThreadState): ChatMessage[] {
  const history = state.messages.map(({ role, content }) => ({ role, content }));
  if (!state.summary) return history;
  return [
    {
      role: "user",
      content: `Summary of the earlier conversation (older messages were compacted):\n${state.summary}`,
    },
    ...history,
  ];
}
