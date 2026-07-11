import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import type { DimensionTuple, GoldenRecord } from "./types.js";

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
  const goldenPath = path.resolve(env.projectRoot, datasetPath ?? "src/eval/golden.jsonl");
  const tuplesPath = path.resolve(path.dirname(goldenPath), "tuples.jsonl");

  const records = readJsonl<GoldenRecord>(goldenPath);
  if (existsSync(tuplesPath)) {
    const byId = new Map(readJsonl<DimensionTuple>(tuplesPath).map((t) => [t.id, t]));
    for (const rec of records) rec.dims = byId.get(rec.id);
  }
  return records;
}

// Filters like query_type=numeric or match_type=numeric_exact. Top-level scorer fields win;
// otherwise the key is matched against the joined dimension tuple.
export function applyFilters(records: GoldenRecord[], filters: Record<string, string>): GoldenRecord[] {
  const entries = Object.entries(filters);
  if (entries.length === 0) return records;

  return records.filter((rec) =>
    entries.every(([key, value]) => {
      const top = (rec as unknown as Record<string, unknown>)[key];
      if (top !== undefined && key !== "dims") return String(top) === value;
      const dim = rec.dims?.[key as keyof typeof rec.dims];
      if (Array.isArray(dim)) return dim.map(String).includes(value);
      return dim !== undefined && String(dim) === value;
    }),
  );
}
