import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "backfill-test-"));
process.env.STATE_DATABASE_PATH = path.join(tmpDir, "state.sqlite");

const { backfillThread } = await import("../handlers.js");
const { getThreadState } = await import("../../memory/thread-store.js");
const { COMPACTION_THRESHOLD } = await import("../../memory/compaction.js");

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
