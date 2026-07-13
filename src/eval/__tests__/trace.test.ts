import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { extractRetrieval, RetrievalCaptureHandler } from "../trace.js";
import type { ToolCall } from "../types.js";

function call(output: unknown): ToolCall {
  return { name: "query_entities", input: "{}", output: typeof output === "string" ? output : JSON.stringify(output) };
}

describe("extractRetrieval", () => {
  test("groups ids by entity across multiple tool calls", () => {
    const grouped = extractRetrieval([
      call({ rows: [], ids: { customers: ["a", "b"] } }),
      call({ rows: [], ids: { artifacts: ["art_1"] } }),
    ]);
    assert.deepEqual(grouped, { customers: ["a", "b"], artifacts: ["art_1"] });
  });

  test("dedupes ids while preserving first-seen order", () => {
    const grouped = extractRetrieval([
      call({ ids: { customers: ["b", "a"] } }),
      call({ ids: { customers: ["a", "c"] } }),
    ]);
    assert.deepEqual(grouped, { customers: ["b", "a", "c"] });
  });

  test("skips outputs that are not JSON", () => {
    const grouped = extractRetrieval([call("plain text error"), call({ ids: { customers: ["a"] } })]);
    assert.deepEqual(grouped, { customers: ["a"] });
  });

  test("skips outputs without an ids object", () => {
    const grouped = extractRetrieval([call({ rows: [{ n: 1 }] }), call({ ids: null })]);
    assert.deepEqual(grouped, {});
  });

  test("ignores non-array entity values and non-string ids", () => {
    const grouped = extractRetrieval([call({ ids: { customers: "a", artifacts: ["art_1", 42] } })]);
    assert.deepEqual(grouped, { artifacts: ["art_1"] });
  });

  test("returns an empty object for no tool calls", () => {
    assert.deepEqual(extractRetrieval([]), {});
  });
});

describe("RetrievalCaptureHandler", () => {
  test("pairs tool starts with their ends by run id", () => {
    const handler = new RetrievalCaptureHandler();
    handler.handleToolStart({}, '{"q":1}', "run-1", undefined, undefined, undefined, "query_entities");
    handler.handleToolStart({}, '{"q":2}', "run-2", undefined, undefined, undefined, "search_artifacts");
    handler.handleToolEnd('{"ids":{}}', "run-2");
    handler.handleToolEnd('{"rows":[]}', "run-1");

    assert.deepEqual(handler.toolCalls, [
      { name: "search_artifacts", input: '{"q":2}', output: '{"ids":{}}' },
      { name: "query_entities", input: '{"q":1}', output: '{"rows":[]}' },
    ]);
  });

  test("unwraps message-shaped outputs to their string content", () => {
    const handler = new RetrievalCaptureHandler();
    handler.handleToolStart({}, "{}", "run-1", undefined, undefined, undefined, "query_entities");
    handler.handleToolEnd({ content: '{"rows":[]}' }, "run-1");
    assert.equal(handler.toolCalls[0]?.output, '{"rows":[]}');
  });

  test("stringifies outputs that are neither strings nor string-content messages", () => {
    const handler = new RetrievalCaptureHandler();
    handler.handleToolStart({}, "{}", "run-1", undefined, undefined, undefined, "query_entities");
    handler.handleToolEnd({ rows: [] }, "run-1");
    assert.equal(handler.toolCalls[0]?.output, '{"rows":[]}');
  });

  test("an end without a matching start records an unknown call rather than dropping it", () => {
    const handler = new RetrievalCaptureHandler();
    handler.handleToolEnd("out", "orphan");
    assert.deepEqual(handler.toolCalls, [{ name: "unknown", input: "", output: "out" }]);
  });
});
