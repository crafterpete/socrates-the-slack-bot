import type {
  AnswerScore,
  EntityType,
  GoldenRecord,
  GroupedIds,
  RetrievalScore,
} from "./types.js";

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

function extractNumbers(text: string): number[] {
  const matches = text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
  return matches.map((m) => Number(m.replace(/,/g, ""))).filter((n) => !Number.isNaN(n));
}

function parseNumber(text: string): number | null {
  const n = Number(text.replace(/,/g, "").trim());
  return Number.isNaN(n) ? null : n;
}

function splitList(text: string): string[] {
  return text
    .split(/[,;\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// The system prompt asks the agent to lead yes/no answers with "Yes"/"No", so the leading
// token is the decisive signal. The cue-based fallback only runs for replies that do not.
function detectPolarity(resp: string): boolean | null {
  const s = resp.trim().toLowerCase();
  if (/^(yes|yep|yeah|correct|true|affirmative)\b/.test(s)) return true;
  if (/^(no|nope|false|none)\b/.test(s)) return false;
  if (/n't|\b(no|not|none|never|false|neither)\b/.test(s)) return false;
  if (/\b(yes|true|correct|is|are|does|do|has|have)\b/.test(s)) return true;
  return null;
}

// Answer eval. Deterministic checks grade the ground-truth `answer` value against the
// agent's free-text response. Heuristics (number extraction, substring presence) are
// intentionally lenient because the response is Slack prose, not a bare value. `judge`
// and null answers defer to manual/LLM review (correct = null).
export function scoreAnswer(rec: GoldenRecord, response: string): AnswerScore {
  const mk = (correct: boolean, detail?: string): AnswerScore => ({
    match_type: rec.match_type,
    correct,
    detail,
  });

  if (rec.match_type === "judge" || rec.answer == null) {
    return { match_type: rec.match_type, correct: null, detail: "deferred to judge/manual" };
  }

  const resp = norm(response);

  switch (rec.match_type) {
    case "numeric_exact": {
      const gold = parseNumber(rec.answer);
      const nums = extractNumbers(response);
      return mk(gold !== null && nums.includes(gold));
    }
    case "numeric_tolerance": {
      const gold = parseNumber(rec.answer);
      const tol = rec.tolerance ?? 0;
      const nums = extractNumbers(response);
      return mk(gold !== null && nums.some((n) => Math.abs(n - gold) <= tol));
    }
    case "boolean": {
      const gold = /^(true|yes)$/i.test(rec.answer.trim());
      const polarity = detectPolarity(resp);
      return mk(polarity !== null && polarity === gold, `detected=${polarity}`);
    }
    case "abstain":
      // rec.answer holds the expected marker ("[Abstain]" or "[Refuse]"); the agent is
      // prompted to emit it when it has no grounded answer or must decline.
      return mk(resp.includes(norm(rec.answer)), `expected marker ${rec.answer}`);
    case "exact_scalar":
      return mk(resp.includes(norm(rec.answer)));
    case "set_equality": {
      const items = splitList(rec.answer);
      const missing = items.filter((i) => !resp.includes(norm(i)));
      return mk(
        missing.length === 0,
        missing.length ? `missing: ${missing.join(", ")}` : "all present (recall only on free text)",
      );
    }
    case "ranked_list": {
      const items = splitList(rec.answer);
      const idxs = items.map((i) => resp.indexOf(norm(i)));
      const allPresent = idxs.every((i) => i >= 0);
      const ordered = allPresent && idxs.every((v, k) => k === 0 || idxs[k - 1]! <= v);
      return mk(
        allPresent && ordered,
        !allPresent ? "missing items" : ordered ? "ordered" : "wrong order",
      );
    }
    default:
      return mk(false, "unknown match_type");
  }
}

// Retrieval eval. Compares predicted ids to relevant_ids per entity_type, then rolls up.
// scored = false when there are no relevant ids to grade against (unanswerable/refusal
// records), so those are excluded from aggregate retrieval metrics.
export function scoreRetrieval(gold: GroupedIds, pred: GroupedIds): RetrievalScore {
  const entities = new Set<EntityType>([
    ...(Object.keys(gold) as EntityType[]),
    ...(Object.keys(pred) as EntityType[]),
  ]);

  let totalGold = 0;
  let totalPred = 0;
  let totalCorrect = 0;
  let mrrSum = 0;
  let mrrCount = 0;
  const perEntity: RetrievalScore["perEntity"] = {};

  for (const e of entities) {
    const g = gold[e] ?? [];
    const p = pred[e] ?? [];
    const gset = new Set(g);
    const correct = new Set(p.filter((id) => gset.has(id)));

    totalGold += g.length;
    totalPred += new Set(p).size;
    totalCorrect += correct.size;

    perEntity[e] = {
      found: correct.size,
      gold: g.length,
      recall: g.length ? correct.size / g.length : p.length === 0 ? 1 : 0,
      precision: p.length ? correct.size / new Set(p).size : g.length === 0 ? 1 : 0,
    };

    if (g.length) {
      const rank = p.findIndex((id) => gset.has(id));
      mrrSum += rank >= 0 ? 1 / (rank + 1) : 0;
      mrrCount += 1;
    }
  }

  return {
    scored: totalGold > 0,
    recall: totalGold ? totalCorrect / totalGold : 1,
    precision: totalPred ? totalCorrect / totalPred : 1,
    mrr: mrrCount ? mrrSum / mrrCount : 1,
    perEntity,
  };
}
