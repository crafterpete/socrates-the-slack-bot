import { ABSTAIN_MARKER, REFUSE_MARKER } from "../shared/markers.js";
import type {
  AnswerScore,
  EntityType,
  GoldenRecord,
  GroupedIds,
  RetrievalModality,
  RetrievalScore,
} from "./types.js";

// MRR measures rank of the first correct id within the predicted-ids array. That array order is
// only a meaningful signal when it reflects an actual relevance ranking (search_artifacts' BM25
// ORDER BY rank); for structured-only cases it's just incidental tool-call/row order, so MRR is
// scored only for the modalities where retrieval is genuinely ranked.
const RANKED_MODALITIES = new Set<RetrievalModality>(["lexical", "semantic", "hybrid"]);

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
      const nums = extractNumbers(response);
      if (gold === null) return mk(false, "gold answer not numeric");
      const tol = rec.tolerance?.absolute ?? (rec.tolerance?.percent != null ? gold * (rec.tolerance.percent / 100) : 0);
      return mk(nums.some((n) => Math.abs(n - gold) <= tol));
    }
    case "boolean": {
      const gold = /^(true|yes)$/i.test(rec.answer.trim());
      const polarity = detectPolarity(resp);
      return mk(polarity !== null && polarity === gold, `detected=${polarity}`);
    }
    // abstain/refuse: the response must begin with the exact marker, per EVALS.md's match_type
    // table ("Response begins with [Abstain]"/"[Refuse]"). Separate match types so the two
    // behaviors (in-scope-but-unsupported vs out-of-scope-or-disallowed) report independently.
    case "abstain":
      return mk(resp.startsWith(norm(ABSTAIN_MARKER)), `expected leading ${ABSTAIN_MARKER}`);
    case "refuse":
      return mk(resp.startsWith(norm(REFUSE_MARKER)), `expected leading ${REFUSE_MARKER}`);
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
// The caller (run.ts) only invokes this when retrieval_evaluation="required"; not_applicable
// and trajectory_only cases are excluded from retrieval metrics upstream, not inferred here
// from id emptiness. `modality` gates MRR: only scored for ranked retrieval (see
// RANKED_MODALITIES above); structured-only cases get mrr=null, not a fabricated 1.0.
export function scoreRetrieval(gold: GroupedIds, pred: GroupedIds, modality: RetrievalModality): RetrievalScore {
  const ranked = RANKED_MODALITIES.has(modality);
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

    if (ranked && g.length) {
      const rank = p.findIndex((id) => gset.has(id));
      mrrSum += rank >= 0 ? 1 / (rank + 1) : 0;
      mrrCount += 1;
    }
  }

  return {
    scored: totalGold > 0,
    recall: totalGold ? totalCorrect / totalGold : 1,
    precision: totalPred ? totalCorrect / totalPred : 1,
    mrr: ranked ? (mrrCount ? mrrSum / mrrCount : 1) : null,
    perEntity,
  };
}
