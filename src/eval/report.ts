import { writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import type { EvalResult } from "./types.js";

const pct = (n: number): string => `${(n * 100).toFixed(0)}%`;

function answerMark(result: EvalResult): string {
  if (!result.answerScore) return "-";
  if (result.answerScore.correct === null) return "judge";
  return result.answerScore.correct ? "pass" : "FAIL";
}

export function printReport(results: EvalResult[]): void {
  const rows = results.map((r) => ({
    id: r.id,
    match: r.answerScore?.match_type ?? "-",
    ans: answerMark(r),
    recall: r.retrievalScore?.scored ? pct(r.retrievalScore.recall) : "-",
    prec: r.retrievalScore?.scored ? pct(r.retrievalScore.precision) : "-",
    mrr: r.retrievalScore?.scored ? r.retrievalScore.mrr.toFixed(2) : "-",
  }));

  const widths = {
    id: Math.max(4, ...rows.map((r) => r.id.length)),
    match: Math.max(9, ...rows.map((r) => r.match.length)),
    ans: 5,
    recall: 6,
    prec: 6,
    mrr: 4,
  };
  const pad = (s: string, w: number) => s.padEnd(w);

  const header = [
    pad("id", widths.id),
    pad("match_type", widths.match),
    pad("ans", widths.ans),
    pad("recall", widths.recall),
    pad("prec", widths.prec),
    pad("mrr", widths.mrr),
  ].join("  ");

  console.log("");
  console.log(header);
  console.log("-".repeat(header.length));
  for (const r of rows) {
    console.log(
      [
        pad(r.id, widths.id),
        pad(r.match, widths.match),
        pad(r.ans, widths.ans),
        pad(r.recall, widths.recall),
        pad(r.prec, widths.prec),
        pad(r.mrr, widths.mrr),
      ].join("  "),
    );
  }

  const graded = results.filter((r) => r.answerScore && r.answerScore.correct !== null);
  const passed = graded.filter((r) => r.answerScore!.correct).length;
  const retrieval = results.filter((r) => r.retrievalScore?.scored);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 1);

  console.log("");
  console.log(
    `answer:    ${passed}/${graded.length} deterministic pass` +
      (results.length - graded.length > 0
        ? `  (${results.length - graded.length} deferred to judge/manual)`
        : ""),
  );
  if (retrieval.length) {
    console.log(
      `retrieval: recall ${pct(mean(retrieval.map((r) => r.retrievalScore!.recall)))}  ` +
        `precision ${pct(mean(retrieval.map((r) => r.retrievalScore!.precision)))}  ` +
        `mrr ${mean(retrieval.map((r) => r.retrievalScore!.mrr)).toFixed(2)}  ` +
        `(${retrieval.length} scored)`,
    );
  }
  console.log("");
}

export function writeReport(results: EvalResult[]): string {
  const out = path.resolve(env.projectRoot, "eval-report.json");
  writeFileSync(out, JSON.stringify(results, null, 2));
  return out;
}
