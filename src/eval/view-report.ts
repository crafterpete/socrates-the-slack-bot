import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../config/env.js";
import { loadDataset } from "./dataset.js";
import type { EvalResult } from "./types.js";

// Turns eval-report.json into one self-contained HTML file: sortable/filterable table plus
// per-row tool-call detail. No dependencies, no server — open the file directly in a browser.

const inPath = path.resolve(env.projectRoot, process.argv[2] ?? "eval-report.json");
const results: EvalResult[] = JSON.parse(readFileSync(inPath, "utf8"));

// Reports written before EvalResult carried `expected`/`expectedIds` lack the gold answer and
// relevant ids; join them back in from the golden dataset by id so the UI can show them without
// re-running the eval.
const goldById = new Map(loadDataset().map((rec) => [rec.id, rec]));
for (const r of results) {
  const gold = goldById.get(r.id);
  if (r.expected == null) r.expected = gold?.answer ?? null;
  if (r.expectedIds == null) r.expectedIds = gold?.relevant_ids ?? {};
}

const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Eval report</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: ui-monospace, monospace; font-size: 13px; margin: 24px; max-width: 1100px; }
  h1 { font-size: 16px; }
  #summary { margin-bottom: 16px; display: flex; gap: 24px; align-items: baseline; flex-wrap: wrap; }
  #passrate { font-size: 28px; font-weight: bold; }
  #summary .detail { opacity: 0.85; }
  #controls { margin-bottom: 12px; display: flex; gap: 12px; }
  input, select { font: inherit; padding: 4px 6px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid color-mix(in srgb, currentColor 15%, transparent); padding: 6px 8px; text-align: left; vertical-align: top; }
  th { cursor: pointer; user-select: none; opacity: 0.75; white-space: nowrap; }
  th:hover { opacity: 1; }
  .pass { color: #2a8f4c; }
  .fail { color: #d0392b; font-weight: bold; }
  .judge { opacity: 0.6; }
  td.q, td.trunc, td.tools { max-width: 240px; vertical-align: top; }
  .clamp { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 5; line-clamp: 5; overflow: hidden; white-space: pre-wrap; word-break: break-word; }
  tr.expanded .clamp { -webkit-line-clamp: unset; line-clamp: unset; overflow: visible; }
  td.exp-col .clamp { color: #2a8f4c; }
  tr.hidden { display: none; }
  td.toggle { width: 20px; text-align: center; }
  .toggle-btn { cursor: pointer; opacity: 0.5; user-select: none; }
  .toggle-btn:hover { opacity: 1; }
  .tools-full { display: none; font-size: 12px; }
  tr.expanded .tools-full { display: block; }
  tr.expanded .tools-preview { display: none; }
  .tools-full .tool { margin-bottom: 6px; }
  .tools-full pre { white-space: pre-wrap; word-break: break-word; margin: 2px 0 0; }
  .tools-full .ids { margin-bottom: 8px; }
  .ids .ent { opacity: 0.5; }
  .ids .hit { color: #2a8f4c; }
  .ids .miss { color: #d0392b; }
  .ids .fp { color: #c98a00; }
  .muted { opacity: 0.5; }
</style>
</head>
<body>
<h1>Eval report</h1>
<div id="summary"></div>
<div id="controls">
  <input id="search" placeholder="filter by id or question…" size="30">
  <select id="verdict">
    <option value="">all verdicts</option>
    <option value="pass">pass</option>
    <option value="FAIL">FAIL</option>
    <option value="judge">judge</option>
  </select>
</div>
<table id="tbl">
  <thead><tr>
    <th data-k="id">id</th>
    <th data-k="verdict">ans</th>
    <th data-k="match">match_type</th>
    <th>question</th>
    <th>answer</th>
    <th>expected</th>
    <th data-k="recall">recall</th>
    <th data-k="precision">prec</th>
    <th data-k="mrr">mrr</th>
    <th data-k="toolCallCount">tools</th>
    <th></th>
  </tr></thead>
  <tbody></tbody>
</table>
<script>
const DATA = ${JSON.stringify(results)};

function verdictOf(r) {
  if (!r.answerScore) return { label: "-", cls: "" };
  if (r.answerScore.correct === null) return { label: "judge", cls: "judge" };
  return r.answerScore.correct ? { label: "pass", cls: "pass" } : { label: "FAIL", cls: "fail" };
}
const pct = (n) => n == null ? "-" : Math.round(n * 100) + "%";

const rows = DATA.map((r) => {
  const v = verdictOf(r);
  return {
    id: r.id, match: r.answerScore?.match_type ?? "-", verdict: v.label, verdictCls: v.cls,
    recall: r.retrievalScore?.scored ? r.retrievalScore.recall : null,
    precision: r.retrievalScore?.scored ? r.retrievalScore.precision : null,
    mrr: r.retrievalScore?.scored ? r.retrievalScore.mrr : null,
    toolCallCount: r.toolCallCount, raw: r,
  };
});

const graded = rows.filter((r) => r.verdict !== "-" && r.verdict !== "judge");
const passed = graded.filter((r) => r.verdict === "pass").length;
const passRate = graded.length ? Math.round((passed / graded.length) * 100) : null;
const scored = rows.filter((r) => r.recall != null);
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
const avgCalls = mean(rows.map((r) => r.toolCallCount));
const maxCalls = Math.max(...rows.map((r) => r.toolCallCount));

document.getElementById("summary").innerHTML =
  \`<span id="passrate" class="\${passRate != null && passRate >= 50 ? "pass" : "fail"}">\${passRate == null ? "-" : passRate + "%"} pass</span>\` +
  \`<span class="detail">answer: \${passed}/\${graded.length} deterministic pass (\${rows.length - graded.length} judge/deferred)<br>\` +
  (scored.length ? \`retrieval: recall \${pct(mean(scored.map((r) => r.recall)))} · precision \${pct(mean(scored.map((r) => r.precision)))} · mrr \${(mean(scored.map((r) => r.mrr)) ?? 0).toFixed(2)} (\${scored.length} scored)<br>\` : "") +
  \`tool calls: avg \${avgCalls.toFixed(1)} · max \${maxCalls}</span>\`;

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Renders grouped ids, comparing against the other side per entity_type (matching scoreRetrieval).
// mode "expected": gold ids, green if retrieved (hit) else red (miss).
// mode "retrieved": predicted ids, green if relevant (hit) else amber (false positive).
function idsHtml(groups, other, mode) {
  const entities = Object.keys(groups || {});
  if (!entities.length) return '<span class="muted">none</span>';
  return entities.map((e) => {
    const otherSet = new Set((other && other[e]) || []);
    const ids = (groups[e] || []).map((id) => {
      const hit = otherSet.has(id);
      const cls = hit ? "hit" : mode === "expected" ? "miss" : "fp";
      return \`<span class="\${cls}">\${escapeHtml(id)}</span>\`;
    }).join(", ");
    return \`<div><span class="ent">\${escapeHtml(e)}:</span> \${ids}</div>\`;
  }).join("");
}

// tools column: a clamped one-line-per-call preview (collapsed) plus the full trace with id
// breakdown (revealed in place when the row expands) — same column, two views.
function toolsPreviewHtml(r) {
  if (!r.toolCalls.length) return '<span class="muted">none</span>';
  return escapeHtml(r.toolCalls.map((t) => \`\${t.name}: \${t.input}\`).join("\\n"));
}
function toolsFullHtml(r) {
  const tools = r.toolCalls.length
    ? r.toolCalls.map((t) =>
        \`<div class="tool"><b>\${escapeHtml(t.name)}</b> <code>\${escapeHtml(t.input)}</code><pre class="muted">\${escapeHtml(t.output.slice(0, 400))}</pre></div>\`
      ).join("")
    : '<span class="muted">none</span>';
  return \`
    <div class="ids"><b>expected ids:</b> \${idsHtml(r.expectedIds, r.predicted, "expected")}</div>
    <div class="ids"><b>retrieved ids:</b> \${idsHtml(r.predicted, r.expectedIds, "retrieved")}</div>
    \${tools}\`;
}

let sortKey = "id", sortDir = 1;
function render() {
  const q = document.getElementById("search").value.toLowerCase();
  const v = document.getElementById("verdict").value;
  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey], bv = b[sortKey];
    if (av == null) return 1;
    if (bv == null) return -1;
    return av < bv ? -sortDir : av > bv ? sortDir : 0;
  });
  const tbody = document.querySelector("#tbl tbody");
  tbody.innerHTML = "";
  for (const r of sorted) {
    if (v && r.verdict !== v) continue;
    if (q && !r.id.toLowerCase().includes(q) && !r.raw.question.toLowerCase().includes(q)) continue;
    const tr = document.createElement("tr");
    tr.innerHTML = \`
      <td>\${r.id}</td>
      <td class="\${r.verdictCls}">\${r.verdict}</td>
      <td>\${r.match}</td>
      <td class="q"><div class="clamp">\${escapeHtml(r.raw.question)}</div></td>
      <td class="trunc"><div class="clamp">\${escapeHtml(r.raw.answer)}</div></td>
      <td class="trunc exp-col">\${r.raw.expected == null ? '<span class="muted">-</span>' : \`<div class="clamp">\${escapeHtml(r.raw.expected)}</div>\`}</td>
      <td>\${pct(r.recall)}</td>
      <td>\${pct(r.precision)}</td>
      <td>\${r.mrr == null ? "-" : r.mrr.toFixed(2)}</td>
      <td class="tools">
        <div class="clamp tools-preview">\${toolsPreviewHtml(r.raw)}</div>
        <div class="tools-full">\${toolsFullHtml(r.raw)}</div>
      </td>
      <td class="toggle"><span class="toggle-btn">▸</span></td>\`;
    tr.querySelector(".toggle-btn").addEventListener("click", () => {
      tr.classList.toggle("expanded");
      tr.querySelector(".toggle-btn").textContent = tr.classList.contains("expanded") ? "▾" : "▸";
    });
    tbody.appendChild(tr);
  }
}
document.querySelectorAll("th[data-k]").forEach((th) => {
  th.addEventListener("click", () => {
    const k = th.dataset.k;
    sortDir = sortKey === k ? -sortDir : 1;
    sortKey = k;
    render();
  });
});
document.getElementById("search").addEventListener("input", render);
document.getElementById("verdict").addEventListener("change", render);
render();
</script>
</body>
</html>
`;

const outPath = inPath.replace(/\.json$/, ".html");
writeFileSync(outPath, html);
console.log(`Wrote ${outPath}`);
