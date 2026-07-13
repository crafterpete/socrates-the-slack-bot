import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChatMessage } from "../../shared/chat.js";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "thread-store-test-"));
process.env.STATE_DATABASE_PATH = path.join(tmpDir, "state.sqlite");

const { appendThreadMessage, compactThread, getThreadState, toAgentMessages } = await import(
  "../thread-store.js"
);
const { COMPACTION_THRESHOLD, KEEP_RECENT, maybeCompactThread } = await import("../compaction.js");

function fillThread(channel: string, threadTs: string, count: number): void {
  for (let i = 0; i < count; i++) {
    appendThreadMessage(channel, threadTs, {
      role: i % 2 === 0 ? "user" : "assistant",
      content: `message ${i}`,
    });
  }
}

describe("thread-store", () => {
  test("append and read back messages in order", () => {
    fillThread("C1", "t1", 3);
    const { summary, messages } = getThreadState("C1", "t1");
    assert.equal(summary, undefined);
    assert.deepEqual(
      messages.map((m) => m.content),
      ["message 0", "message 1", "message 2"],
    );
  });

  test("threads are isolated from each other and from the channel key", () => {
    appendThreadMessage("C2", "t1", { role: "user", content: "thread one" });
    appendThreadMessage("C2", "t2", { role: "user", content: "thread two" });
    appendThreadMessage("C2", undefined, { role: "user", content: "channel level" });

    assert.equal(getThreadState("C2", "t1").messages.length, 1);
    assert.equal(getThreadState("C2", "t2").messages.length, 1);
    assert.equal(getThreadState("C2").messages.length, 1);
    assert.equal(getThreadState("C2", "t1").messages[0]?.content, "thread one");
  });

  test("compactThread stores summary and deletes folded messages", () => {
    fillThread("C3", "t1", 4);
    const { messages } = getThreadState("C3", "t1");
    const throughId = messages[1]?.id;
    assert.ok(throughId);

    compactThread("C3", "t1", { summary: "first two messages", throughId });

    const after = getThreadState("C3", "t1");
    assert.equal(after.summary, "first two messages");
    assert.deepEqual(
      after.messages.map((m) => m.content),
      ["message 2", "message 3"],
    );
  });

  test("toAgentMessages prepends the summary as context", () => {
    const rendered = toAgentMessages({
      summary: "earlier stuff",
      messages: [{ id: 1, role: "user", content: "hi" }],
    });
    assert.equal(rendered.length, 2);
    assert.equal(rendered[0]?.role, "user");
    assert.match(rendered[0]?.content ?? "", /earlier stuff/);
    assert.deepEqual(rendered[1], { role: "user", content: "hi" });
  });
});

describe("maybeCompactThread", () => {
  test("no-op below the threshold", async () => {
    fillThread("C4", "t1", COMPACTION_THRESHOLD - 1);
    const compacted = await maybeCompactThread("C4", "t1", async () => "unused");
    assert.equal(compacted, false);
    assert.equal(getThreadState("C4", "t1").messages.length, COMPACTION_THRESHOLD - 1);
  });

  test("folds all but the recent tail into a summary", async () => {
    fillThread("C5", "t1", COMPACTION_THRESHOLD);
    let seenPrevious: string | undefined = "sentinel";
    let seenMessages: ChatMessage[] = [];
    const compacted = await maybeCompactThread("C5", "t1", async (previous, messages) => {
      seenPrevious = previous;
      seenMessages = messages;
      return "summary v1";
    });

    assert.equal(compacted, true);
    assert.equal(seenPrevious, undefined);
    assert.equal(seenMessages.length, COMPACTION_THRESHOLD - KEEP_RECENT);

    const after = getThreadState("C5", "t1");
    assert.equal(after.summary, "summary v1");
    assert.equal(after.messages.length, KEEP_RECENT);
    assert.equal(after.messages[0]?.content, `message ${COMPACTION_THRESHOLD - KEEP_RECENT}`);
  });

  test("repeated compaction receives the previous summary", async () => {
    fillThread("C5", "t1", COMPACTION_THRESHOLD - KEEP_RECENT);
    let seenPrevious: string | undefined;
    const compacted = await maybeCompactThread("C5", "t1", async (previous) => {
      seenPrevious = previous;
      return "summary v2";
    });

    assert.equal(compacted, true);
    assert.equal(seenPrevious, "summary v1");
    assert.equal(getThreadState("C5", "t1").summary, "summary v2");
    assert.equal(getThreadState("C5", "t1").messages.length, KEEP_RECENT);
  });
});
