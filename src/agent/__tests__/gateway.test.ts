import assert from "node:assert/strict";
import { afterEach, describe, mock, test } from "node:test";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { requestConfig, withToolGateway } from "../gateway.js";

const echoTool = tool(
  (args: { q: string }) => JSON.stringify({ rows: [{ q: args.q }], ids: {} }),
  {
    name: "echo",
    description: "Echoes the query back as a single row",
    schema: z.object({ q: z.string() }),
  },
);

const failingTool = tool(
  () => {
    throw new Error("boom");
  },
  {
    name: "fail",
    description: "Always throws",
    schema: z.object({}),
  },
);

function captureLogs(): string[] {
  const logs: string[] = [];
  mock.method(console, "log", (line: unknown) => {
    logs.push(String(line));
  });
  return logs;
}

afterEach(() => {
  mock.restoreAll();
});

describe("withToolGateway", () => {
  test("preserves tool name, description, and schema", () => {
    const [wrapped] = withToolGateway([echoTool]);
    assert.equal(wrapped?.name, "echo");
    assert.equal(wrapped?.description, echoTool.description);
    assert.equal(wrapped?.schema, echoTool.schema);
  });

  test("passes output through unchanged without a request context", async () => {
    const logs = captureLogs();
    const [wrapped] = withToolGateway([echoTool]);
    const output = await wrapped?.invoke({ q: "hello" });
    assert.equal(output, JSON.stringify({ rows: [{ q: "hello" }], ids: {} }));
    assert.equal(logs.length, 0);
  });

  test("audits calls made with a request context", async () => {
    const logs = captureLogs();
    const [wrapped] = withToolGateway([echoTool]);
    const config = requestConfig({ userId: "U123", channel: "C9", threadTs: "1.2" });
    const output = await wrapped?.invoke({ q: "hello" }, config);
    assert.equal(output, JSON.stringify({ rows: [{ q: "hello" }], ids: {} }));

    assert.equal(logs.length, 1);
    const entry = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    assert.equal(entry.event, "tool_call");
    assert.equal(entry.user, "U123");
    assert.equal(entry.channel, "C9");
    assert.equal(entry.tool, "echo");
    assert.deepEqual(entry.args, { q: "hello" });
    assert.equal(entry.rows, 1);
    assert.equal(typeof entry.ms, "number");
  });

  test("traces exactly one tool run per call", async () => {
    class ToolRunCounter extends BaseCallbackHandler {
      name = "tool_run_counter";
      starts = 0;
      handleToolStart(): void {
        this.starts += 1;
      }
    }
    const counter = new ToolRunCounter();
    const [wrapped] = withToolGateway([echoTool]);
    await wrapped?.invoke({ q: "hello" }, { callbacks: [counter] });
    assert.equal(counter.starts, 1);
  });

  test("audits and rethrows tool errors", async () => {
    const logs = captureLogs();
    const [wrapped] = withToolGateway([failingTool]);
    const config = requestConfig({ userId: "U123" });
    await assert.rejects(async () => wrapped?.invoke({}, config), /boom/);

    assert.equal(logs.length, 1);
    const entry = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    assert.equal(entry.user, "U123");
    assert.equal(entry.tool, "fail");
    assert.match(String(entry.error), /boom/);
  });
});
