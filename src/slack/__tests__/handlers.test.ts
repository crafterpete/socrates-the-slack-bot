import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "handlers-test-"));
process.env.STATE_DATABASE_PATH = path.join(tmpDir, "state.sqlite");

const { backfillThread, deliverAnswer, reactionSentiment } = await import("../handlers.js");
const { getThreadState } = await import("../../memory/thread-store.js");
const { COMPACTION_THRESHOLD } = await import("../../memory/compaction.js");
const { listFeedback, recordFeedback } = await import("../../memory/feedback-store.js");

describe("deliverAnswer", () => {
  test("edits the placeholder and records the answer under its ts", async () => {
    const updates: { channel: string; ts: string; text: string }[] = [];
    await deliverAnswer({
      channel: "C_DLV",
      threadTs: "t1",
      question: "how many customers?",
      answer: "42 customers.",
      replyTs: "111.1",
      update: async (args) => updates.push(args),
      say: async () => assert.fail("say should not be called when a placeholder exists"),
    });

    assert.deepEqual(updates, [{ channel: "C_DLV", ts: "111.1", text: "42 customers." }]);
    assert.equal(recordFeedback({ responseTs: "111.1", channel: "C_DLV", userId: "U1", sentiment: "up" }), true);
    const row = listFeedback().find((r) => r.response_ts === "111.1");
    assert.equal(row?.question, "how many customers?");
    assert.equal(row?.answer, "42 customers.");
  });

  test("falls back to a fresh message and records the answer under the posted ts", async () => {
    const said: { text: string; thread_ts?: string }[] = [];
    await deliverAnswer({
      channel: "C_DLV",
      threadTs: "t2",
      question: "q",
      answer: "fresh answer",
      replyTs: undefined,
      update: async () => assert.fail("update should not be called without a placeholder"),
      say: async (message) => {
        said.push(message);
        return { ts: "222.2" };
      },
    });

    assert.deepEqual(said, [{ text: "fresh answer", thread_ts: "t2" }]);
    assert.equal(recordFeedback({ responseTs: "222.2", channel: "C_DLV", userId: "U1", sentiment: "down" }), true);
  });

  test("still delivers when say returns no ts, leaving the answer unrecorded", async () => {
    const said: string[] = [];
    await deliverAnswer({
      channel: "C_DLV",
      threadTs: "t3",
      question: "q",
      answer: "untracked answer",
      replyTs: undefined,
      update: async () => undefined,
      say: async (message) => {
        said.push(message.text);
        return undefined;
      },
    });

    assert.deepEqual(said, ["untracked answer"]);
  });
});

describe("reactionSentiment", () => {
  test("thumbs-up reactions and aliases map to up", () => {
    assert.equal(reactionSentiment("+1"), "up");
    assert.equal(reactionSentiment("thumbsup"), "up");
  });

  test("thumbs-down reactions and aliases map to down", () => {
    assert.equal(reactionSentiment("-1"), "down");
    assert.equal(reactionSentiment("thumbsdown"), "down");
  });

  test("skin-tone variants still count", () => {
    assert.equal(reactionSentiment("+1::skin-tone-3"), "up");
    assert.equal(reactionSentiment("-1::skin-tone-5"), "down");
  });

  test("every other reaction is ignored", () => {
    assert.equal(reactionSentiment("heart"), null);
    assert.equal(reactionSentiment("thumbsup_alt"), null);
    assert.equal(reactionSentiment(""), null);
  });
});

type Reply = { text?: string; user?: string; ts?: string; subtype?: string; bot_id?: string };

function pagedFetcher(pages: Reply[][]) {
  const calls: (string | undefined)[] = [];
  const fetch = async (args: { cursor?: string }) => {
    calls.push(args.cursor);
    const page = Number(args.cursor ?? 0);
    return {
      messages: pages[page],
      response_metadata: page + 1 < pages.length ? { next_cursor: String(page + 1) } : {},
    };
  };
  return { fetch, calls };
}

describe("backfillThread", () => {
  test("keeps only the newest COMPACTION_THRESHOLD human messages across pages", async () => {
    const total = COMPACTION_THRESHOLD + 10;
    const all: Reply[] = Array.from({ length: total }, (_, i) => ({
      text: `msg ${i}`,
      user: `U${i % 3}`,
      ts: `${i}`,
    }));
    const { fetch } = pagedFetcher([all.slice(0, 12), all.slice(12)]);

    await backfillThread(fetch, "C_BF1", "t1", "trigger");

    const { messages } = getThreadState("C_BF1", "t1");
    assert.equal(messages.length, COMPACTION_THRESHOLD);
    assert.equal(messages[0]?.content, `msg ${total - COMPACTION_THRESHOLD}`);
    assert.equal(messages.at(-1)?.content, `msg ${total - 1}`);
    assert.equal(messages[0]?.author, `U${(total - COMPACTION_THRESHOLD) % 3}`);
  });

  test("skips bot messages, subtypes, and the triggering mention", async () => {
    const { fetch } = pagedFetcher([
      [
        { text: "root question", user: "U1", ts: "1" },
        { text: "bot answer", user: "UBOT", bot_id: "B1", ts: "2" },
        { text: "joined the channel", user: "U2", subtype: "channel_join", ts: "3" },
        { text: "human reply", user: "U2", ts: "4" },
        { text: "<@UBOT> what do you think?", user: "U1", ts: "trigger" },
      ],
    ]);

    await backfillThread(fetch, "C_BF2", "t1", "trigger");

    const { messages } = getThreadState("C_BF2", "t1");
    assert.deepEqual(
      messages.map((m) => m.content),
      ["root question", "human reply"],
    );
  });
});
