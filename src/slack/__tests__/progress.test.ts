import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "progress-test-"));
process.env.STATE_DATABASE_PATH = path.join(tmpDir, "state.sqlite");

const { progressLine, SlackProgressHandler } = await import("../handlers.js");

describe("progressLine", () => {
  test("includes the tool-call count", () => {
    assert.match(progressLine(1), /Inquiry 1:/);
    assert.match(progressLine(5), /Inquiry 5:/);
  });

  test("cycles blurbs instead of running out", () => {
    const first = progressLine(1).replace(/Inquiry 1/, "");
    const eighth = progressLine(8).replace(/Inquiry 8/, "");
    assert.equal(first, eighth);
    assert.notEqual(progressLine(1), progressLine(2));
  });
});

describe("SlackProgressHandler", () => {
  test("posts one update per tool call in order", async () => {
    const seen: string[] = [];
    const handler = new SlackProgressHandler(async (text) => {
      seen.push(text);
    }, 0);

    handler.handleToolStart();
    handler.handleToolStart();
    handler.handleToolStart();
    await handler.finish();

    assert.deepEqual(seen, [progressLine(1), progressLine(2), progressLine(3)]);
  });

  test("throttles updates inside the minimum interval", async () => {
    const seen: string[] = [];
    const handler = new SlackProgressHandler(async (text) => {
      seen.push(text);
    }, 60_000);

    handler.handleToolStart();
    handler.handleToolStart();
    handler.handleToolStart();
    await handler.finish();

    assert.deepEqual(seen, [progressLine(1)]);
  });

  test("never posts after finish, so the answer cannot be overwritten", async () => {
    const seen: string[] = [];
    const handler = new SlackProgressHandler(async (text) => {
      seen.push(text);
    }, 0);

    handler.handleToolStart();
    await handler.finish();
    handler.handleToolStart();
    await handler.finish();

    assert.deepEqual(seen, [progressLine(1)]);
  });

  test("swallows update failures instead of breaking the run", async () => {
    const handler = new SlackProgressHandler(async () => {
      throw new Error("slack is down");
    }, 0);

    handler.handleToolStart();
    await assert.doesNotReject(handler.finish());
  });
});
