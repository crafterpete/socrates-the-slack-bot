import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { GOLDEN_FILENAME, TUPLES_FILENAME } from "./paths.js";
import type { CaseTuple, GoldenRecord } from "./types.js";

function readJsonl<T>(filePath: string): T[] {
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .map((line, i) => ({ line: line.trim(), lineNumber: i + 1 }))
    .filter(({ line }) => line && !line.startsWith("//"))
    .map(({ line, lineNumber }) => {
      try {
        return JSON.parse(line) as T;
      } catch (err) {
        throw new Error(`Invalid JSON on ${path.basename(filePath)} line ${lineNumber}: ${(err as Error).message}`);
      }
    });
}

// Left-joins tuples.jsonl by id so records carry their dimension tuple while golden.jsonl stays lean.
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

// A dotted key (e.g. provenance.suite) resolves against the joined `dims`; an undotted key checks the top-level record first.
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
