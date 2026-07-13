import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedback-store-test-"));
process.env.STATE_DATABASE_PATH = path.join(tmpDir, "state.sqlite");

const { recordAgentResponse, recordFeedback, removeFeedback, listFeedback } = await import(
  "../feedback-store.js"
);

function seedResponse(messageTs: string): void {
  recordAgentResponse({
    messageTs,
    channel: "C1",
    threadTs: "t1",
    question: `q for ${messageTs}`,
    answer: `a for ${messageTs}`,
  });
}

describe("feedback-store", () => {
  test("reactions on unknown messages are ignored", () => {
    const recorded = recordFeedback({ responseTs: "unknown", channel: "C1", userId: "U1", sentiment: "up" });
    assert.equal(recorded, false);
    assert.equal(listFeedback().length, 0);
  });

  test("records a thumbs up against the answer it judges", () => {
    seedResponse("100.1");
    const recorded = recordFeedback({ responseTs: "100.1", channel: "C1", userId: "U1", sentiment: "up" });
    assert.equal(recorded, true);

    const rows = listFeedback();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sentiment, "up");
    assert.equal(rows[0]?.question, "q for 100.1");
    assert.equal(rows[0]?.answer, "a for 100.1");
    assert.equal(rows[0]?.thread_ts, "t1");
  });

  test("a user's second reaction overwrites their verdict rather than adding a row", () => {
    seedResponse("200.1");
    recordFeedback({ responseTs: "200.1", channel: "C1", userId: "U2", sentiment: "up" });
    recordFeedback({ responseTs: "200.1", channel: "C1", userId: "U2", sentiment: "down" });

    const rows = listFeedback().filter((r) => r.response_ts === "200.1");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.sentiment, "down");
  });

  test("different users leave independent feedback on the same answer", () => {
    seedResponse("300.1");
    recordFeedback({ responseTs: "300.1", channel: "C1", userId: "U3", sentiment: "up" });
    recordFeedback({ responseTs: "300.1", channel: "C1", userId: "U4", sentiment: "down" });

    assert.equal(listFeedback().filter((r) => r.response_ts === "300.1").length, 2);
  });

  test("removing a reaction retracts only the matching sentiment", () => {
    seedResponse("400.1");
    recordFeedback({ responseTs: "400.1", channel: "C1", userId: "U5", sentiment: "up" });

    removeFeedback({ responseTs: "400.1", userId: "U5", sentiment: "down" });
    assert.equal(listFeedback().filter((r) => r.response_ts === "400.1").length, 1);

    removeFeedback({ responseTs: "400.1", userId: "U5", sentiment: "up" });
    assert.equal(listFeedback().filter((r) => r.response_ts === "400.1").length, 0);
  });

  test("listFeedback filters by sentiment", () => {
    assert.ok(listFeedback("up").every((r) => r.sentiment === "up"));
    assert.ok(listFeedback("down").every((r) => r.sentiment === "down"));
  });
});
