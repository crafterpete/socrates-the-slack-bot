import assert from "node:assert/strict";
import { describe, test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyFilters, loadDataset } from "../dataset.js";
import { TUPLES_FILENAME } from "../paths.js";
import type { CaseTuple, GoldenRecord } from "../types.js";

function rec(id: string, extra?: Partial<GoldenRecord>): GoldenRecord {
  return {
    id,
    question: "q",
    answer: "a",
    match_type: "exact_scalar",
    retrieval_evaluation: "not_applicable",
    relevant_ids: {},
    ...extra,
  };
}

function dims(partial: Record<string, unknown>): CaseTuple {
  return partial as unknown as CaseTuple;
}

describe("applyFilters", () => {
  const records = [
    rec("0001", { match_type: "boolean", dims: dims({ provenance: { suite: "adversarial" }, task: { entities: ["customers", "artifacts"] }, complexity_bucket: "simple" }) }),
    rec("0002", { match_type: "exact_scalar", dims: dims({ provenance: { suite: "core_deterministic" }, task: { entities: ["products"] }, complexity_bucket: "complex" }) }),
    rec("0003", { match_type: "boolean" }),
  ];

  test("no filters returns every record", () => {
    assert.equal(applyFilters(records, {}).length, 3);
  });

  test("an undotted key matches a top-level record field", () => {
    assert.deepEqual(applyFilters(records, { match_type: "boolean" }).map((r) => r.id), ["0001", "0003"]);
  });

  test("id filtering selects a single case", () => {
    assert.deepEqual(applyFilters(records, { id: "0002" }).map((r) => r.id), ["0002"]);
  });

  test("a dotted key resolves inside the joined dims", () => {
    assert.deepEqual(applyFilters(records, { "provenance.suite": "adversarial" }).map((r) => r.id), ["0001"]);
  });

  test("an undotted key absent from the record falls back to dims", () => {
    assert.deepEqual(applyFilters(records, { complexity_bucket: "complex" }).map((r) => r.id), ["0002"]);
  });

  test("an array-valued dim matches when it contains the value", () => {
    assert.deepEqual(applyFilters(records, { "task.entities": "customers" }).map((r) => r.id), ["0001"]);
  });

  test("records without dims never match a dims filter", () => {
    assert.equal(applyFilters(records, { "provenance.suite": "core_deterministic" }).some((r) => r.id === "0003"), false);
  });

  test("multiple filters combine with AND", () => {
    assert.deepEqual(
      applyFilters(records, { match_type: "boolean", "provenance.suite": "adversarial" }).map((r) => r.id),
      ["0001"],
    );
  });
});

describe("loadDataset", () => {
  function writeDataset(golden: string[], tuples?: string[]): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dataset-test-"));
    const goldenPath = path.join(dir, "golden.jsonl");
    fs.writeFileSync(goldenPath, golden.join("\n") + "\n");
    if (tuples) fs.writeFileSync(path.join(dir, TUPLES_FILENAME), tuples.join("\n") + "\n");
    return goldenPath;
  }

  test("parses records and skips blank and comment lines", () => {
    const goldenPath = writeDataset([
      "// === suite: core_deterministic ===",
      JSON.stringify(rec("0001")),
      "",
      JSON.stringify(rec("0002")),
    ]);
    assert.deepEqual(loadDataset(goldenPath).map((r) => r.id), ["0001", "0002"]);
  });

  test("joins tuples onto records by id as dims", () => {
    const goldenPath = writeDataset(
      [JSON.stringify(rec("0001")), JSON.stringify(rec("0002"))],
      [JSON.stringify({ id: "0002", provenance: { suite: "adversarial" } })],
    );
    const [first, second] = loadDataset(goldenPath);
    assert.equal(first?.dims, undefined);
    assert.equal(second?.dims?.provenance.suite, "adversarial");
  });

  test("loads without dims when no tuples file exists", () => {
    const goldenPath = writeDataset([JSON.stringify(rec("0001"))]);
    const records = loadDataset(goldenPath);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.dims, undefined);
  });

  test("names the offending line when a record is invalid JSON", () => {
    const goldenPath = writeDataset([JSON.stringify(rec("0001")), "{not json"]);
    assert.throws(() => loadDataset(goldenPath), /golden\.jsonl line 2/);
  });

  test("reports the real file line number even with comment lines above", () => {
    const goldenPath = writeDataset([
      "// === suite: core_deterministic ===",
      JSON.stringify(rec("0001")),
      "{not json",
    ]);
    assert.throws(() => loadDataset(goldenPath), /golden\.jsonl line 3/);
  });
});
