import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { GOLDEN_FILENAME, TUPLES_FILENAME } from "./paths.js";
import type { CaseTuple, GoldenRecord } from "./types.js";

function readJsonl<T>(filePath: string): T[] {
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//"))
    .map((line, i) => {
      try {
        return JSON.parse(line) as T;
      } catch (err) {
        throw new Error(`Invalid JSON on ${path.basename(filePath)} line ${i + 1}: ${(err as Error).message}`);
      }
    });
}

// Loads golden.jsonl and left-joins tuples.jsonl by id so records carry their dimension
// tuple for filtering, while golden.jsonl itself stays lean.
export function loadDataset(datasetPath?: string): GoldenRecord[] {
  const goldenPath = path.resolve(env.projectRoot, datasetPath ?? path.join("src/eval", GOLDEN_FILENAME));
  const tuplesPath = path.resolve(path.dirname(goldenPath), TUPLES_FILENAME);

  const records = readJsonl<GoldenRecord>(goldenPath);
  if (existsSync(tuplesPath)) {
    const byId = new Map(readJsonl<CaseTuple>(tuplesPath).map((t) => [t.id, t]));
    for (const rec of records) rec.dims = byId.get(rec.id);
  }
  return records;
}

function getPath(obj: unknown, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>((cur, key) => {
    if (cur == null || typeof cur !== "object") return undefined;
    return (cur as Record<string, unknown>)[key];
  }, obj);
}

// Filters like match_type=numeric_exact (top-level scorer field) or provenance.suite=
// semantic_stress / task.operation=aggregate (dot-path into the joined CaseTuple). Top-level
// scorer fields win when the key has no dot; otherwise it's resolved against `dims`.
export function applyFilters(records: GoldenRecord[], filters: Record<string, string>): GoldenRecord[] {
  const entries = Object.entries(filters);
  if (entries.length === 0) return records;

  return records.filter((rec) =>
    entries.every(([key, value]) => {
      if (!key.includes(".")) {
        const top = (rec as unknown as Record<string, unknown>)[key];
        if (top !== undefined && key !== "dims") return String(top) === value;
      }
      const dim = key.includes(".") ? getPath(rec.dims, key) : (rec.dims as Record<string, unknown> | undefined)?.[key];
      if (Array.isArray(dim)) return dim.map(String).includes(value);
      return dim !== undefined && String(dim) === value;
    }),
  );
}
