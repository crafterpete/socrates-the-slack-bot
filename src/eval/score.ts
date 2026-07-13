import { ABSTAIN_MARKER, REFUSE_MARKER } from "../shared/markers.js";
import type {
  AnswerScore,
  EntityType,
  GoldenRecord,
  GroupedIds,
  RetrievalModality,
  RetrievalScore,
} from "./types.js";

// MRR only means something when predicted-id order reflects a real ranking, not incidental row order.
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

function isNonDecreasing(xs: number[]): boolean {
  for (let i = 1; i < xs.length; i++) {
    const prev = xs[i - 1] ?? Number.NEGATIVE_INFINITY;
    const cur = xs[i] ?? Number.POSITIVE_INFINITY;
    if (prev > cur) return false;
  }
  return true;
}

// Leading token is decisive (system prompt asks for a leading Yes/No); cue regexes are a fallback.
function detectPolarity(resp: string): boolean | null {
  const s = resp.trim().toLowerCase();
  if (/^(yes|yep|yeah|correct|true|affirmative)\b/.test(s)) return true;
  if (/^(no|nope|false|none)\b/.test(s)) return false;
  if (/n't|\b(no|not|none|never|false|neither)\b/.test(s)) return false;
  if (/\b(yes|true|correct|is|are|does|do|has|have)\b/.test(s)) return true;
  return null;
}

// Grades free-text Slack prose against a ground-truth answer; judge/null match_types defer to manual review.
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
    // Separate match types so unsupported-but-in-scope vs out-of-scope report independently.
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
      // Last occurrence, not first: a "shows its work" response repeats items in scratch order
      // before the final sorted list, and the final list is where each item last appears.
      const items = splitList(rec.answer);
      const idxs = items.map((i) => resp.lastIndexOf(norm(i)));
      const allPresent = idxs.every((i) => i >= 0);
      const ordered = allPresent && isNonDecreasing(idxs);
      return mk(
        allPresent && ordered,
        !allPresent ? "missing items" : ordered ? "ordered" : "wrong order",
      );
    }
    default:
      return mk(false, "unknown match_type");
  }
}

// Caller only invokes this for retrieval_evaluation="required"; mrr is null (not 0) for unranked modalities.
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
    precision: totalPred ? totalCorrect / totalPred : totalGold === 0 ? 1 : 0,
    mrr: ranked ? (mrrCount ? mrrSum / mrrCount : 1) : null,
    perEntity,
  };
}
