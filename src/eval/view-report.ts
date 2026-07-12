import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { loadDataset } from "./dataset.js";
import { REPORT_FILENAME } from "./paths.js";
import { DEFAULT_SUITE, SUITE_ORDER } from "./types.js";
import type { EvalResult } from "./types.js";

// Turns eval-report.json into one self-contained HTML file: a sortable/filterable triage table
// (Console) or per-case cards, each opening a full-width detail pane with the answer/expected
// reading panes, retrieval id breakdown, and tool-call trace. No dependencies, no server — open
// the file directly in a browser.

const inPath = path.resolve(env.projectRoot, process.argv[2] ?? REPORT_FILENAME);
const results: EvalResult[] = JSON.parse(readFileSync(inPath, "utf8"));

// Reports written before EvalResult carried `expected`/`expectedIds` lack the gold answer and
// relevant ids; join them back in from the golden dataset by id so the UI can show them without
// re-running the eval. Also join `suite` and `tags` (from tuples.jsonl) for suite-segmented
// display and tag-based browsing, mirroring the console report's per-suite breakdown.
const goldById = new Map(loadDataset().map((rec) => [rec.id, rec]));
const withSuite = results.map((r) => ({
  ...r,
  suite: goldById.get(r.id)?.dims?.provenance.suite ?? DEFAULT_SUITE,
  tags: goldById.get(r.id)?.dims?.diagnostics?.tags ?? [],
  expected: r.expected ?? goldById.get(r.id)?.answer ?? null,
  expectedIds: r.expectedIds ?? goldById.get(r.id)?.relevant_ids ?? {},
}));

// Flatten to the lean shape the client renderer consumes, so the ported client script needs no
// per-field digging into the nested EvalResult. `correct` is undefined when ungraded, null when
// deferred to judge, boolean otherwise. Tool outputs are truncated for display.
const rows = withSuite.map((r) => ({
  id: r.id,
  suite: r.suite,
  tags: r.tags,
  correct: r.answerScore ? r.answerScore.correct : undefined,
  match: r.answerScore?.match_type ?? "-",
  detail: r.answerScore?.detail ?? null,
  question: r.question,
  answer: r.answer,
  expected: r.expected,
  recall: r.retrievalScore?.scored ? r.retrievalScore.recall : null,
  precision: r.retrievalScore?.scored ? r.retrievalScore.precision : null,
  mrr: r.retrievalScore?.scored ? r.retrievalScore.mrr : null,
  expectedIds: r.expectedIds,
  predicted: r.predicted,
  toolCallCount: r.toolCallCount,
  toolCalls: r.toolCalls.map((t) => ({ name: t.name, input: t.input, output: t.output.slice(0, 400) })),
}));

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Eval report</title>
<style>
  :root {
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    --mono: ui-monospace, "SF Mono", "SFMono-Regular", Menlo, Consolas, monospace;

    --bg: #f5f8fb; --surface: #ffffff; --panel: #eef2f7; --panel-2: #e3e9f1;
    --ink: #12202e; --ink-soft: #566476; --ink-faint: #8593a2;
    --border: #dbe3ec; --border-strong: #c6d1de;
    --accent: #3f57d6; --accent-soft: rgba(63,87,214,.10);
    --pass: #147a43; --pass-bg: rgba(20,122,67,.12);
    --fail: #cc372b; --fail-bg: rgba(204,55,43,.12);
    --judge: #a06d00; --judge-bg: rgba(160,109,0,.13);
    --hit: #147a43; --miss: #cc372b; --fp: #a06d00;
    --meter-track: #dde4ec;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c1016; --surface: #141a22; --panel: #1a222d; --panel-2: #212b38;
      --ink: #e7eef6; --ink-soft: #9db0c3; --ink-faint: #66768a;
      --border: #27313f; --border-strong: #34414f;
      --accent: #7f95ff; --accent-soft: rgba(127,149,255,.12);
      --pass: #45c684; --pass-bg: rgba(69,198,132,.14);
      --fail: #ff6f62; --fail-bg: rgba(255,111,98,.14);
      --judge: #e3ad3f; --judge-bg: rgba(227,173,63,.14);
      --hit: #45c684; --miss: #ff6f62; --fp: #e3ad3f;
      --meter-track: #2a3543;
    }
  }
  :root[data-theme="light"] {
    --bg: #f5f8fb; --surface: #ffffff; --panel: #eef2f7; --panel-2: #e3e9f1;
    --ink: #12202e; --ink-soft: #566476; --ink-faint: #8593a2;
    --border: #dbe3ec; --border-strong: #c6d1de; --accent: #3f57d6; --accent-soft: rgba(63,87,214,.10);
    --pass: #147a43; --pass-bg: rgba(20,122,67,.12); --fail: #cc372b; --fail-bg: rgba(204,55,43,.12);
    --judge: #a06d00; --judge-bg: rgba(160,109,0,.13);
    --hit: #147a43; --miss: #cc372b; --fp: #a06d00; --meter-track: #dde4ec;
  }
  :root[data-theme="dark"] {
    --bg: #0c1016; --surface: #141a22; --panel: #1a222d; --panel-2: #212b38;
    --ink: #e7eef6; --ink-soft: #9db0c3; --ink-faint: #66768a;
    --border: #27313f; --border-strong: #34414f; --accent: #7f95ff; --accent-soft: rgba(127,149,255,.12);
    --pass: #45c684; --pass-bg: rgba(69,198,132,.14); --fail: #ff6f62; --fail-bg: rgba(255,111,98,.14);
    --judge: #e3ad3f; --judge-bg: rgba(227,173,63,.14);
    --hit: #45c684; --miss: #ff6f62; --fp: #e3ad3f; --meter-track: #2a3543;
  }

  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); font-size: 14px; line-height: 1.5; }
  .wrap { max-width: 1180px; margin: 0 auto; padding: 28px 24px 80px; }
  .num { font-family: var(--mono); font-variant-numeric: tabular-nums; }

  /* header */
  header.rep { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; flex-wrap: wrap; margin-bottom: 20px; }
  .title h1 { font-size: 20px; font-weight: 650; letter-spacing: -.01em; margin: 0 0 2px; }
  .title .sub { color: var(--ink-faint); font-size: 12.5px; font-family: var(--mono); }
  .headline { display: flex; align-items: stretch; gap: 20px; }
  .hstat .lbl { font-size: 11px; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-soft); margin-bottom: 3px; }
  .hstat .big { font-size: 34px; font-weight: 680; letter-spacing: -.02em; font-family: var(--mono); font-variant-numeric: tabular-nums; line-height: 1; }
  .hstat .big .of { color: var(--ink-faint); font-weight: 500; }
  .hsep { width: 1px; background: var(--border); }
  .hmetrics { display: flex; gap: 16px; align-items: flex-end; }
  .hmetrics .m { display: flex; flex-direction: column; gap: 2px; }
  .hmetrics .m .mv { font-family: var(--mono); font-size: 22px; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -.01em; line-height: 1; }
  .hmetrics .m .mk { font-size: 10px; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-faint); }
  .hmetrics .scored { font-size: 11px; color: var(--ink-faint); font-family: var(--mono); }

  .suites { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 18px; }
  .suite-chip { display: flex; align-items: baseline; gap: 8px; padding: 7px 12px; background: var(--surface); border: 1px solid var(--border); border-radius: 9px; font-size: 12.5px; }
  .suite-chip .nm { color: var(--ink-soft); }
  .suite-chip .rt { font-family: var(--mono); font-weight: 600; font-variant-numeric: tabular-nums; }
  .suite-chip .bar { width: 46px; height: 5px; border-radius: 3px; background: var(--meter-track); overflow: hidden; align-self: center; }
  .suite-chip .bar > i { display: block; height: 100%; background: var(--pass); }
  .suite-chip .rc { color: var(--ink-faint); font-family: var(--mono); font-size: 11.5px; }

  /* controls */
  .controls { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 16px; }
  .controls input, .controls select { font: inherit; font-size: 13px; padding: 7px 10px; border: 1px solid var(--border-strong); border-radius: 8px; background: var(--surface); color: var(--ink); }
  .controls input { min-width: 230px; }
  .controls input:focus, .controls select:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
  .spacer { flex: 1; }
  .seg { display: inline-flex; background: var(--panel); border: 1px solid var(--border); border-radius: 9px; padding: 3px; }
  .seg button { font: inherit; font-size: 12.5px; font-weight: 550; border: 0; background: transparent; color: var(--ink-soft); padding: 5px 13px; border-radius: 6px; cursor: pointer; }
  .seg button[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.08); }

  /* pills + chips */
  .pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 650; letter-spacing: .02em; padding: 2px 9px; border-radius: 100px; font-family: var(--mono); }
  .pill.pass { color: var(--pass); background: var(--pass-bg); }
  .pill.fail { color: var(--fail); background: var(--fail-bg); }
  .pill.judge { color: var(--judge); background: var(--judge-bg); }
  .pill.pass::before, .pill.fail::before, .pill.judge::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .chip-suite { font-size: 11px; color: var(--ink-soft); background: var(--panel); border: 1px solid var(--border); padding: 2px 8px; border-radius: 6px; font-family: var(--mono); }
  .match { font-size: 11.5px; color: var(--ink-soft); font-family: var(--mono); }
  .tags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  .tags.row-tags { margin-top: 3px; }
  .chip-tag { font-size: 11px; color: var(--accent); background: var(--accent-soft); border: 1px solid transparent; padding: 2px 8px; border-radius: 6px; font-family: var(--mono); }

  /* mini meter */
  .meter { display: flex; align-items: center; gap: 7px; }
  .meter .track { width: 40px; height: 5px; border-radius: 3px; background: var(--meter-track); overflow: hidden; }
  .meter .track > i { display: block; height: 100%; background: var(--accent); }
  .meter .track.lo > i { background: var(--fail); }
  .meter .track.mid > i { background: var(--judge); }
  .meter .v { font-family: var(--mono); font-size: 12px; font-variant-numeric: tabular-nums; color: var(--ink-soft); min-width: 30px; }
  .dash { color: var(--ink-faint); }

  /* ===== CONSOLE (table) ===== */
  .tablecard { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
  table { border-collapse: collapse; width: 100%; }
  thead th { position: sticky; top: 0; z-index: 2; background: var(--panel); text-align: left; font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-soft); font-weight: 600; padding: 10px 12px; border-bottom: 1px solid var(--border); white-space: nowrap; cursor: pointer; user-select: none; }
  thead th.sortable:hover { color: var(--ink); }
  thead th .arr { opacity: .5; font-size: 9px; }
  tbody td { padding: 11px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
  tbody tr.row { cursor: pointer; }
  tbody tr.row:hover td { background: var(--accent-soft); }
  tbody tr.row.open td { background: var(--panel); }
  td.c-chev { width: 26px; color: var(--ink-faint); text-align: center; }
  td.c-chev .cx { display: inline-block; transition: transform .12s; }
  tr.open td.c-chev .cx { transform: rotate(90deg); color: var(--accent); }
  td.c-id { font-family: var(--mono); font-size: 12.5px; color: var(--ink-soft); white-space: nowrap; }
  td.c-q { max-width: 420px; }
  td.c-q .qt { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; color: var(--ink); }
  tr.detailrow > td { padding: 0; background: var(--panel); border-bottom: 1px solid var(--border); }
  .detailwrap { padding: 4px 18px 22px; }

  /* ===== detail panel (shared) ===== */
  .detail { display: grid; gap: 16px; }
  .qlead { display: grid; gap: 5px; }
  .lbl-eyebrow { font-size: 10.5px; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-faint); font-weight: 600; }
  .qlead .qtext { font-size: 16px; line-height: 1.45; font-weight: 500; color: var(--ink); max-width: 78ch; }

  .aecols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 760px) { .aecols { grid-template-columns: 1fr; } }
  .pane { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
  .pane > .head { display: flex; align-items: center; justify-content: space-between; padding: 8px 13px; border-bottom: 1px solid var(--border); font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; font-weight: 600; }
  .pane.answer > .head { color: var(--accent); }
  .pane.expected > .head { color: var(--ink-soft); }
  .pane .body { padding: 13px 14px; font-size: 14px; line-height: 1.62; color: var(--ink); white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; max-height: 340px; overflow: auto; }
  .pane.expected .body { color: var(--ink-soft); }
  .pane .body strong, .pane .body b { color: var(--ink); font-weight: 650; }
  .pane .body code { font-family: var(--mono); font-size: 12.5px; background: var(--panel-2); padding: 1px 4px; border-radius: 4px; }
  .verdict-strip { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px; color: var(--ink-soft); }
  .verdict-strip .scorer-detail { font-family: var(--mono); font-size: 12px; color: var(--ink); background: var(--panel-2); padding: 2px 8px; border-radius: 6px; }

  /* retrieval */
  .retrieval { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 13px 14px; display: grid; gap: 12px; }
  .retrieval .rhead { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .retrieval .metric { display: flex; align-items: baseline; gap: 6px; }
  .retrieval .metric .k { font-size: 10.5px; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-faint); }
  .retrieval .metric .val { font-family: var(--mono); font-weight: 650; font-size: 15px; font-variant-numeric: tabular-nums; }
  .idgrid { display: grid; gap: 8px; }
  .idrow { display: grid; grid-template-columns: 96px 1fr; gap: 10px; align-items: start; }
  .idrow .side { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-faint); font-weight: 600; padding-top: 4px; }
  .idchips { display: flex; flex-wrap: wrap; gap: 5px; }
  .idchip { font-family: var(--mono); font-size: 11.5px; padding: 2px 7px; border-radius: 6px; border: 1px solid transparent; }
  .idchip .ent { opacity: .55; }
  .idchip.hit { color: var(--hit); background: var(--pass-bg); }
  .idchip.miss { color: var(--miss); background: var(--fail-bg); }
  .idchip.fp { color: var(--fp); background: var(--judge-bg); }
  .idchip.none { color: var(--ink-faint); border-color: var(--border); }

  /* trace */
  .trace { display: grid; gap: 8px; }
  .trace .thead { display: flex; align-items: center; gap: 8px; }
  .trace .thead .count { font-size: 12px; color: var(--ink-soft); font-family: var(--mono); }
  .tool { border: 1px solid var(--border); border-radius: 9px; background: var(--surface); overflow: hidden; }
  .tool > summary { list-style: none; cursor: pointer; padding: 9px 12px; display: flex; align-items: center; gap: 9px; font-size: 12.5px; }
  .tool > summary::-webkit-details-marker { display: none; }
  .tool > summary .tw { color: var(--ink-faint); font-size: 10px; transition: transform .12s; }
  .tool[open] > summary .tw { transform: rotate(90deg); }
  .tool > summary .nm { font-family: var(--mono); font-weight: 600; color: var(--accent); }
  .tool > summary .in { font-family: var(--mono); color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
  .tool .out { border-top: 1px solid var(--border); padding: 10px 12px; }
  .tool .out .k { font-size: 10px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-faint); margin-bottom: 4px; }
  .tool .out pre { margin: 0 0 10px; font-family: var(--mono); font-size: 11.5px; line-height: 1.55; color: var(--ink-soft); white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
  .tool .out pre:last-child { margin-bottom: 0; }

  /* ===== CARDS ===== */
  .cards { display: grid; gap: 14px; }
  .card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px 18px 18px; }
  .card > .chead { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin-bottom: 13px; }
  .card > .chead .cid { font-family: var(--mono); font-size: 12.5px; color: var(--ink-soft); }
  .card > .chead .spacer2 { flex: 1; }
  .card > .chead .mini { display: flex; gap: 12px; align-items: center; }
  .card > .chead .mini .m { display: flex; align-items: baseline; gap: 5px; font-size: 11px; color: var(--ink-faint); }
  .card > .chead .mini .m b { font-family: var(--mono); font-size: 12.5px; color: var(--ink-soft); font-weight: 600; }
  .card .detail { gap: 14px; }
  .card .qlead .qtext { font-size: 15px; }

  .empty { padding: 40px; text-align: center; color: var(--ink-faint); }
  footer.note { margin-top: 24px; font-size: 11.5px; color: var(--ink-faint); text-align: center; font-family: var(--mono); }
</style>
</head>
<body>
<div class="wrap">
  <header class="rep">
    <div class="title">
      <h1>Eval report</h1>
      <div class="sub" id="meta"></div>
    </div>
    <div class="headline">
      <div class="hstat">
        <div class="lbl">deterministic pass</div>
        <div class="big" id="passbig"></div>
      </div>
      <div class="hsep"></div>
      <div class="hstat">
        <div class="lbl">retrieval</div>
        <div class="hmetrics" id="retrievalbig"></div>
      </div>
    </div>
  </header>

  <div class="suites" id="suites"></div>

  <div class="controls">
    <input id="search" placeholder="Filter by id or question…" aria-label="Filter">
    <select id="verdict" aria-label="Verdict">
      <option value="">All verdicts</option>
      <option value="pass">Pass</option>
      <option value="fail">Fail</option>
      <option value="judge">Judge</option>
    </select>
    <select id="suite" aria-label="Suite"><option value="">All suites</option></select>
    <div class="spacer"></div>
    <div class="seg" role="group" aria-label="View">
      <button id="v-console" aria-pressed="true">Console</button>
      <button id="v-cards" aria-pressed="false">Cards</button>
    </div>
  </div>

  <div id="view"></div>
  <footer class="note">Open a row to read the full answer / expected panes, retrieval, and tool trace.</footer>
</div>

<script>
const DATA = ${JSON.stringify(rows)};

const pct = (n) => n == null ? "—" : Math.round(n * 100) + "%";
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// light markdown: **bold** and \`code\`, over escaped text; newlines preserved via CSS white-space.
const md = (s) => esc(s).replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>").replace(/\`([^\`]+)\`/g, "<code>$1</code>");

function verdictOf(r) {
  if (r.correct === true) return { k: "pass", label: "pass" };
  if (r.correct === false) return { k: "fail", label: "fail" };
  if (r.correct === null) return { k: "judge", label: "judge" };
  return { k: "", label: "—" };
}
const meterCls = (n) => n == null ? "" : n >= 0.75 ? "" : n >= 0.4 ? "mid" : "lo";
function meter(n) {
  if (n == null) return '<span class="dash">—</span>';
  return '<span class="meter"><span class="track ' + meterCls(n) + '"><i style="width:' + Math.round(n * 100) + '%"></i></span><span class="v">' + pct(n) + '</span></span>';
}

function tagChips(tags) {
  if (!tags || !tags.length) return "";
  return '<div class="tags">' + tags.map((t) => '<span class="chip-tag">' + esc(t) + '</span>').join("") + '</div>';
}

// Renders grouped ids, comparing against the other side per entity_type (matching scoreRetrieval).
// mode "expected": gold ids, green if retrieved (hit) else red (miss).
// mode "retrieved": predicted ids, green if relevant (hit) else amber (false positive).
function idChips(groups, other, mode) {
  const ents = Object.keys(groups || {});
  if (!ents.length) return '<span class="idchip none">none</span>';
  let out = "";
  for (const e of ents) {
    const oset = new Set((other && other[e]) || []);
    for (const id of (groups[e] || [])) {
      const hit = oset.has(id);
      const cls = hit ? "hit" : mode === "expected" ? "miss" : "fp";
      out += '<span class="idchip ' + cls + '"><span class="ent">' + esc(e.slice(0, 3)) + '·</span>' + esc(id) + '</span>';
    }
  }
  return out;
}

function retrievalHtml(r) {
  if (!(r.recall != null || Object.keys(r.expectedIds || {}).length || Object.keys(r.predicted || {}).length)) return "";
  const metrics = r.recall == null ? "" :
    '<div class="metric"><span class="k">recall</span><span class="val">' + pct(r.recall) + '</span></div>' +
    '<div class="metric"><span class="k">precision</span><span class="val">' + pct(r.precision) + '</span></div>' +
    '<div class="metric"><span class="k">mrr</span><span class="val">' + (r.mrr == null ? "—" : r.mrr.toFixed(2)) + '</span></div>';
  return '<div class="retrieval">' +
    '<div class="rhead"><span class="lbl-eyebrow">Retrieval</span>' + metrics + '</div>' +
    '<div class="idgrid">' +
      '<div class="idrow"><span class="side">Expected</span><span class="idchips">' + idChips(r.expectedIds, r.predicted, "expected") + '</span></div>' +
      '<div class="idrow"><span class="side">Retrieved</span><span class="idchips">' + idChips(r.predicted, r.expectedIds, "retrieved") + '</span></div>' +
    '</div></div>';
}

function traceHtml(r) {
  if (!r.toolCalls || !r.toolCalls.length) return "";
  const tools = r.toolCalls.map((t) =>
    '<details class="tool"><summary><span class="tw">▶</span><span class="nm">' + esc(t.name) + '</span><span class="in">' + esc(t.input) + '</span></summary>' +
    '<div class="out"><div class="k">input</div><pre>' + esc(t.input) + '</pre><div class="k">output</div><pre>' + esc(t.output) + '</pre></div></details>'
  ).join("");
  return '<div class="trace"><div class="thead"><span class="lbl-eyebrow">Trace</span><span class="count">' + r.toolCallCount + ' call' + (r.toolCallCount === 1 ? "" : "s") + '</span></div>' + tools + '</div>';
}

function detailHtml(r) {
  const scorer = r.detail ? '<span class="scorer-detail">' + esc(r.detail) + '</span>' : "";
  const v = verdictOf(r);
  return '<div class="detail">' +
    '<div class="qlead"><span class="lbl-eyebrow">Question</span><div class="qtext">' + esc(r.question) + '</div>' + tagChips(r.tags) + '</div>' +
    '<div class="aecols">' +
      '<div class="pane answer"><div class="head"><span>Model answer</span><span class="pill ' + v.k + '">' + v.label + '</span></div><div class="body">' + md(r.answer) + '</div></div>' +
      '<div class="pane expected"><div class="head"><span>Expected</span><span class="match">' + esc(r.match) + '</span></div><div class="body">' + (r.expected == null ? '<span class="dash">— no gold answer —</span>' : md(r.expected)) + '</div></div>' +
    '</div>' +
    (scorer ? '<div class="verdict-strip"><span class="lbl-eyebrow">Scorer</span>' + scorer + '</div>' : "") +
    retrievalHtml(r) +
    traceHtml(r) +
  '</div>';
}

// ---- state ----
const firstFail = DATA.find((r) => r.correct === false);
const state = { view: "console", q: "", verdict: "", suite: "", sortKey: "id", sortDir: 1, open: new Set(firstFail ? [firstFail.id] : []) };

function filtered() {
  const rows = DATA.filter((r) => {
    if (state.verdict && verdictOf(r).k !== state.verdict) return false;
    if (state.suite && r.suite !== state.suite) return false;
    if (state.q) {
      const q = state.q.toLowerCase();
      const tagHit = (r.tags || []).some((t) => t.toLowerCase().includes(q));
      if (!r.id.toLowerCase().includes(q) && !r.question.toLowerCase().includes(q) && !tagHit) return false;
    }
    return true;
  });
  const k = state.sortKey;
  rows.sort((a, b) => {
    let av = a[k], bv = b[k];
    if (k === "verdict") { av = verdictOf(a).label; bv = verdictOf(b).label; }
    if (av == null) return 1;
    if (bv == null) return -1;
    return av < bv ? -state.sortDir : av > bv ? state.sortDir : 0;
  });
  return rows;
}

const COLS = [
  { k: "id", label: "id", sortable: true },
  { k: "suite", label: "suite", sortable: true },
  { k: "verdict", label: "ans", sortable: true },
  { k: "match", label: "match", sortable: true },
  { k: "question", label: "question", sortable: false },
  { k: "recall", label: "recall", sortable: true },
  { k: "precision", label: "prec", sortable: true },
  { k: "mrr", label: "mrr", sortable: true },
  { k: "toolCallCount", label: "tools", sortable: true },
];

function renderConsole(rows) {
  const arrow = (k) => state.sortKey === k ? '<span class="arr">' + (state.sortDir === 1 ? "▲" : "▼") + '</span>' : "";
  const head = '<th class="c-chev"></th>' + COLS.map((c) =>
    '<th class="' + (c.sortable ? "sortable" : "") + '" data-k="' + c.k + '">' + c.label + " " + (c.sortable ? arrow(c.k) : "") + '</th>').join("");
  let body = "";
  for (const r of rows) {
    const v = verdictOf(r);
    const open = state.open.has(r.id);
    body += '<tr class="row ' + (open ? "open" : "") + '" data-id="' + esc(r.id) + '">' +
      '<td class="c-chev"><span class="cx">›</span></td>' +
      '<td class="c-id">' + esc(r.id) + '</td>' +
      '<td><span class="chip-suite">' + esc(r.suite.replace(/_/g, " ")) + '</span></td>' +
      '<td><span class="pill ' + v.k + '">' + v.label + '</span></td>' +
      '<td><span class="match">' + esc(r.match) + '</span></td>' +
      '<td class="c-q"><div class="qt">' + esc(r.question) + '</div>' + (r.tags && r.tags.length ? '<div class="tags row-tags">' + r.tags.map((t) => '<span class="chip-tag">' + esc(t) + '</span>').join("") + '</div>' : "") + '</td>' +
      '<td>' + meter(r.recall) + '</td>' +
      '<td>' + meter(r.precision) + '</td>' +
      '<td class="num">' + (r.mrr == null ? '<span class="dash">—</span>' : r.mrr.toFixed(2)) + '</td>' +
      '<td class="num">' + r.toolCallCount + '</td>' +
    '</tr>';
    if (open) body += '<tr class="detailrow"><td colspan="' + (COLS.length + 1) + '"><div class="detailwrap">' + detailHtml(r) + '</div></td></tr>';
  }
  if (!rows.length) body = '<tr><td colspan="' + (COLS.length + 1) + '"><div class="empty">No cases match the filters.</div></td></tr>';
  return '<div class="tablecard"><table><thead><tr>' + head + '</tr></thead><tbody>' + body + '</tbody></table></div>';
}

function renderCards(rows) {
  if (!rows.length) return '<div class="tablecard"><div class="empty">No cases match the filters.</div></div>';
  return '<div class="cards">' + rows.map((r) => {
    const v = verdictOf(r);
    const mini = (r.recall == null ? "" :
      '<span class="m">recall <b>' + pct(r.recall) + '</b></span><span class="m">prec <b>' + pct(r.precision) + '</b></span>' +
      (r.mrr == null ? "" : '<span class="m">mrr <b>' + r.mrr.toFixed(2) + '</b></span>')) +
      '<span class="m">tools <b>' + r.toolCallCount + '</b></span>';
    return '<div class="card">' +
      '<div class="chead"><span class="pill ' + v.k + '">' + v.label + '</span><span class="cid">' + esc(r.id) + '</span>' +
        '<span class="chip-suite">' + esc(r.suite.replace(/_/g, " ")) + '</span><span class="match">' + esc(r.match) + '</span>' +
        '<span class="spacer2"></span><span class="mini">' + mini + '</span></div>' +
      detailHtml(r) + '</div>';
  }).join("") + '</div>';
}

function render() {
  const rows = filtered();
  document.getElementById("view").innerHTML = state.view === "console" ? renderConsole(rows) : renderCards(rows);
  if (state.view === "console") {
    document.querySelectorAll("tr.row").forEach((tr) => tr.addEventListener("click", () => {
      const id = tr.dataset.id;
      if (state.open.has(id)) state.open.delete(id); else state.open.add(id);
      render();
    }));
    document.querySelectorAll("th.sortable").forEach((th) => th.addEventListener("click", () => {
      const k = th.dataset.k;
      state.sortDir = state.sortKey === k ? -state.sortDir : 1;
      state.sortKey = k;
      render();
    }));
  }
}

function renderSummary() {
  const graded = DATA.filter((r) => r.correct === true || r.correct === false);
  const passed = graded.filter((r) => r.correct === true).length;
  document.getElementById("passbig").innerHTML = passed + '<span class="of"> / ' + graded.length + '</span>';
  document.getElementById("meta").textContent = DATA.length + " cases · " + (DATA.length - graded.length) + " judge/deferred";

  const scored = DATA.filter((r) => r.recall != null);
  const mrrScored = scored.filter((r) => r.mrr != null);
  document.getElementById("retrievalbig").innerHTML = scored.length ?
    '<div class="m"><span class="mv">' + pct(mean(scored.map((r) => r.recall))) + '</span><span class="mk">recall</span></div>' +
    '<div class="m"><span class="mv">' + pct(mean(scored.map((r) => r.precision))) + '</span><span class="mk">precision</span></div>' +
    '<div class="m"><span class="mv">' + (mrrScored.length ? mean(mrrScored.map((r) => r.mrr)).toFixed(2) : "—") + '</span><span class="mk">mrr</span></div>' +
    '<span class="scored">' + scored.length + ' scored</span>'
    : '<span class="scored">none scored</span>';

  const suiteOrder = ${JSON.stringify(SUITE_ORDER)};
  const suites = [...new Set(DATA.map((r) => r.suite))].sort((a, b) => {
    const ai = suiteOrder.indexOf(a), bi = suiteOrder.indexOf(b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });
  document.getElementById("suite").innerHTML = '<option value="">All suites</option>' + suites.map((s) => '<option value="' + s + '">' + s.replace(/_/g, " ") + '</option>').join("");
  document.getElementById("suites").innerHTML = suites.map((s) => {
    const rs = DATA.filter((r) => r.suite === s);
    const g = rs.filter((r) => r.correct === true || r.correct === false);
    const p = g.filter((r) => r.correct === true).length;
    const ratio = g.length ? p / g.length : 0;
    const sc = rs.filter((r) => r.recall != null);
    const rc = sc.length ? '<span class="rc">R ' + pct(mean(sc.map((r) => r.recall))) + '</span>' : "";
    return '<div class="suite-chip"><span class="nm">' + s.replace(/_/g, " ") + '</span>' +
      '<span class="bar"><i style="width:' + Math.round(ratio * 100) + '%"></i></span>' +
      '<span class="rt">' + p + '/' + g.length + '</span>' + rc + '</div>';
  }).join("");
}

document.getElementById("search").addEventListener("input", (e) => { state.q = e.target.value; render(); });
document.getElementById("verdict").addEventListener("change", (e) => { state.verdict = e.target.value; render(); });
document.getElementById("suite").addEventListener("change", (e) => { state.suite = e.target.value; render(); });
function setView(v) {
  state.view = v;
  document.getElementById("v-console").setAttribute("aria-pressed", v === "console");
  document.getElementById("v-cards").setAttribute("aria-pressed", v === "cards");
  render();
}
document.getElementById("v-console").addEventListener("click", () => setView("console"));
document.getElementById("v-cards").addEventListener("click", () => setView("cards"));

renderSummary();
render();
</script>
</body>
</html>
`;

const outPath = inPath.replace(/\.json$/, ".html");
writeFileSync(outPath, html);
console.log(`Wrote ${outPath}`);
