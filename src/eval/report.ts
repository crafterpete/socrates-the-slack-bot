import { writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { REPORT_FILENAME } from "./paths.js";
import { DEFAULT_SUITE, SUITE_ORDER } from "./types.js";
import type { AnswerScore, EvalResult, ProvenanceSuite, RetrievalScore } from "./types.js";

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;
const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);

function answerMark(result: EvalResult): string {
  if (!result.answerScore) return "-";
  if (result.answerScore.correct === null) return "judge";
  return result.answerScore.correct ? "pass" : "FAIL";
}

function printSuiteTable(label: string, results: EvalResult[]): void {
  if (!results.length) return;
  const rows = results.map((r) => ({
    id: r.id,
    match: r.answerScore?.match_type ?? "-",
    ans: answerMark(r),
    recall: r.retrievalScore?.scored ? pct(r.retrievalScore.recall) : "-",
    prec: r.retrievalScore?.scored ? pct(r.retrievalScore.precision) : "-",
    mrr: r.retrievalScore?.scored && r.retrievalScore.mrr != null ? r.retrievalScore.mrr.toFixed(2) : "-",
    calls: String(r.toolCalls.length),
  }));
  const widths = {
    id: Math.max(4, ...rows.map((r) => r.id.length)),
    match: Math.max(9, ...rows.map((r) => r.match.length)),
    ans: 5, recall: 6, prec: 6, mrr: 4, calls: 5,
  };
  const pad = (s: string, w: number) => s.padEnd(w);
  const header = [pad("id", widths.id), pad("match_type", widths.match), pad("ans", widths.ans), pad("recall", widths.recall), pad("prec", widths.prec), pad("mrr", widths.mrr), pad("calls", widths.calls)].join("  ");

  console.log(`\n-- ${label} (${results.length}) --`);
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log([pad(r.id, widths.id), pad(r.match, widths.match), pad(r.ans, widths.ans), pad(r.recall, widths.recall), pad(r.prec, widths.prec), pad(r.mrr, widths.mrr), pad(r.calls, widths.calls)].join("  "));
  }
  printSummaryLine(results);
}

function printSummaryLine(results: EvalResult[]): void {
  const graded = results
    .map((r) => r.answerScore)
    .filter((s): s is AnswerScore => s != null && s.correct !== null);
  const passed = graded.filter((s) => s.correct).length;
  const retrieval = results
    .map((r) => r.retrievalScore)
    .filter((s): s is RetrievalScore => s?.scored ?? false);
  const avgCalls = mean(results.map((r) => r.toolCalls.length));
  const maxCalls = results.length ? Math.max(...results.map((r) => r.toolCalls.length)) : 0;

  console.log(
    `  answer: ${passed}/${graded.length} deterministic pass` +
      (results.length - graded.length > 0 ? `  (${results.length - graded.length} deferred to judge/manual)` : ""),
  );
  console.log(`  tool calls: avg ${avgCalls.toFixed(1)}  max ${maxCalls}`);
  if (retrieval.length) {
    const mrrVals = retrieval.map((s) => s.mrr).filter((v): v is number => v != null);
    console.log(
      `  retrieval: recall ${pct(mean(retrieval.map((s) => s.recall)))}  ` +
        `precision ${pct(mean(retrieval.map((s) => s.precision)))}  ` +
        `mrr ${mrrVals.length ? mean(mrrVals).toFixed(2) : "-"}  ` +
        `(${retrieval.length} scored, ${mrrVals.length} ranked)`,
    );
  }
}

// Reports each provenance suite separately before any aggregate so a low-scoring suite stays visible.
export function printReport(results: EvalResult[], suiteById: Map<string, ProvenanceSuite | string>): void {
  const bySuite = new Map<string, EvalResult[]>();
  for (const r of results) {
    const suite = suiteById.get(r.id) ?? DEFAULT_SUITE;
    const group = bySuite.get(suite) ?? [];
    group.push(r);
    bySuite.set(suite, group);
  }

  console.log("");
  for (const suite of SUITE_ORDER) {
    printSuiteTable(suite, bySuite.get(suite) ?? []);
  }
  for (const [suite, rs] of bySuite) {
    if (!SUITE_ORDER.includes(suite as ProvenanceSuite)) printSuiteTable(suite, rs);
  }

  console.log(`\n== overall core (${results.length}) ==`);
  printSummaryLine(results);
  console.log("");
}

export function writeReport(results: EvalResult[]): string {
  const out = path.resolve(env.projectRoot, REPORT_FILENAME);
  writeFileSync(out, JSON.stringify(results, null, 2));
  return out;
}
