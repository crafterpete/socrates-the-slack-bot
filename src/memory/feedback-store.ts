import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";

export type Sentiment = "up" | "down";

export type FeedbackRow = {
  id: number;
  response_ts: string;
  channel: string;
  thread_ts: string | null;
  user_id: string;
  sentiment: Sentiment;
  question: string;
  answer: string;
  created_at: string;
  updated_at: string;
};

let db: Database.Database | undefined;

function getDb(): Database.Database {
  if (!db) {
    fs.mkdirSync(path.dirname(env.stateDatabasePath), { recursive: true });
    db = new Database(env.stateDatabasePath);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_responses (
        message_ts TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        thread_ts TEXT,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE TABLE IF NOT EXISTS feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        response_ts TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread_ts TEXT,
        user_id TEXT NOT NULL,
        sentiment TEXT NOT NULL CHECK (sentiment IN ('up', 'down')),
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (response_ts, user_id)
      );
      CREATE INDEX IF NOT EXISTS feedback_by_sentiment ON feedback(sentiment);
    `);
  }
  return db;
}

// Records what Socrates actually said under the message ts it was posted at, so a later reaction on
// that message can be traced back to the question and answer it is judging.
export function recordAgentResponse(args: {
  messageTs: string;
  channel: string;
  threadTs?: string;
  question: string;
  answer: string;
}): void {
  getDb()
    .prepare(
      `INSERT INTO agent_responses (message_ts, channel, thread_ts, question, answer)
       VALUES (@messageTs, @channel, @threadTs, @question, @answer)
       ON CONFLICT(message_ts) DO UPDATE SET
         question = excluded.question,
         answer = excluded.answer`,
    )
    .run({
      messageTs: args.messageTs,
      channel: args.channel,
      threadTs: args.threadTs ?? null,
      question: args.question,
      answer: args.answer,
    });
}

// Records a thumbs up/down on an agent message. Returns false (a no-op) if the reacted-to message is
// not one of Socrates' recorded answers, so stray reactions on other messages are ignored. A user's
// verdict on a given answer is a single row: reacting again overwrites their previous sentiment.
export function recordFeedback(args: {
  responseTs: string;
  channel: string;
  userId: string;
  sentiment: Sentiment;
}): boolean {
  const store = getDb();
  const response = store
    .prepare("SELECT thread_ts, question, answer FROM agent_responses WHERE message_ts = ?")
    .get(args.responseTs) as { thread_ts: string | null; question: string; answer: string } | undefined;
  if (!response) return false;

  store
    .prepare(
      `INSERT INTO feedback (response_ts, channel, thread_ts, user_id, sentiment, question, answer)
       VALUES (@responseTs, @channel, @threadTs, @userId, @sentiment, @question, @answer)
       ON CONFLICT(response_ts, user_id) DO UPDATE SET
         sentiment = excluded.sentiment,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    )
    .run({
      responseTs: args.responseTs,
      channel: args.channel,
      threadTs: response.thread_ts,
      userId: args.userId,
      sentiment: args.sentiment,
      question: response.question,
      answer: response.answer,
    });
  return true;
}

// Retracts a user's feedback when they remove their reaction. Scoped to the matching sentiment so
// removing an unrelated reaction never clears a real thumbs up/down.
export function removeFeedback(args: { responseTs: string; userId: string; sentiment: Sentiment }): void {
  getDb()
    .prepare("DELETE FROM feedback WHERE response_ts = ? AND user_id = ? AND sentiment = ?")
    .run(args.responseTs, args.userId, args.sentiment);
}

export function listFeedback(sentiment?: Sentiment): FeedbackRow[] {
  const store = getDb();
  return sentiment
    ? (store.prepare("SELECT * FROM feedback WHERE sentiment = ? ORDER BY id").all(sentiment) as FeedbackRow[])
    : (store.prepare("SELECT * FROM feedback ORDER BY id").all() as FeedbackRow[]);
}
