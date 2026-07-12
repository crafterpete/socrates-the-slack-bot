import type {
  Answerability,
  AnswerShape,
  CaseSpec,
  ComplexityBucket,
  EntityType,
  GroupedIds,
  MatchType,
  RequiredOperation,
  RetrievalModality,
  SourceGrounding,
} from "./types.js";

// Pure taxonomy rules (see EVALS.md): derivations and the build-time validator.
// Kept free of I/O and of the specific case data so it is independently testable — see
// src/eval/__tests__/taxonomy-rules.test.ts. build-golden.ts imports this module; it must not
// duplicate these rules inline.

export function deriveMatchType(answerShape: AnswerShape, answerability: Answerability, hasTolerance: boolean): MatchType {
  if (answerability === "unanswerable") return "abstain";
  if (answerability === "out_of_scope" || answerability === "disallowed") return "refuse";
  switch (answerShape) {
    case "scalar": return "exact_scalar";
    case "count": return "numeric_exact";
    case "numeric": return hasTolerance ? "numeric_tolerance" : "numeric_exact";
    case "boolean": return "boolean";
    case "set": return "set_equality";
    case "ranked_list": return "ranked_list";
    case "free_text": return "judge";
  }
}

export function deriveSourceGrounding(modality: RetrievalModality): SourceGrounding {
  switch (modality) {
    case "none": return "none";
    case "structured": return "structured_table";
    case "lexical": case "semantic": return "artifact_content";
    case "hybrid": return "mixed";
  }
}

export function deriveComplexityBucket(requiredOperations: RequiredOperation[]): ComplexityBucket {
  const n = requiredOperations.length;
  if (n <= 2) return "simple";
  if (n <= 4) return "compound";
  return "complex";
}

// Fails on structural contradictions per EVALS.md. This is not a natural-language
// theorem prover: it catches obvious, mechanically-checkable inconsistencies only. Throws
// Error(message) on the first violation found; the message never carries the "gold_" id
// prefix here — callers (build-golden.ts) can prepend context if useful.
export function validateCase(
  question: string,
  spec: CaseSpec,
  answer: string | null,
  relevantIds: GroupedIds,
  messages: unknown[] | undefined,
): void {
  const fail = (msg: string): never => {
    throw new Error(msg);
  };
  const { provenance, task, composition, retrieval, challenge, output } = spec;
  const ops = new Set(composition.requiredOperations);
  const idEntities = Object.keys(relevantIds) as EntityType[];
  const hasIds = idEntities.some((e) => (relevantIds[e]?.length ?? 0) > 0);

  if (composition.history === "multi_turn" && !messages?.length)
    fail("history=multi_turn requires messages");
  // Heuristic only: obvious unresolved-referent openers. Not a general NLP check.
  if (composition.history === "single_message" && /^(their|its|that day|those|it\b)/i.test(question.trim()))
    fail("single_message question appears to open with an unresolved pronoun/referent");

  if (composition.temporalScope === "none" && ops.has("date_filter"))
    fail("temporal_scope=none but required_operations contains date_filter");
  if (composition.temporalScope !== "none" && !ops.has("date_filter"))
    fail("temporal_scope!=none requires date_filter in required_operations");

  if (retrieval.modality === "structured" && (ops.has("lexical_match") || ops.has("semantic_match")))
    fail("modality=structured but required_operations contains a text-matching operation");
  if (retrieval.modality === "lexical" && !ops.has("lexical_match"))
    fail("modality=lexical requires lexical_match in required_operations");
  if (retrieval.modality === "semantic" && !ops.has("semantic_match"))
    fail("modality=semantic requires semantic_match in required_operations");
  if (retrieval.modality === "hybrid") {
    const structuredOp = ops.has("filter") || ops.has("join") || ops.has("date_filter") || ops.has("group") || ops.has("aggregate");
    const textOp = ops.has("lexical_match") || ops.has("semantic_match");
    if (!structuredOp || !textOp) fail("modality=hybrid requires at least one structured op and one text op");
  }
  if (retrieval.modality === "none" && hasIds) fail("modality=none but relevant_ids is non-empty");

  if (retrieval.evaluation === "required" && !hasIds) fail("evaluation=required but relevant_ids is empty");
  if (retrieval.evaluation === "not_applicable" && hasIds) fail("evaluation=not_applicable but relevant_ids is non-empty");
  if (retrieval.searchExpectation === "no_search_expected" && retrieval.modality !== "none")
    fail("search_expectation=no_search_expected requires modality=none");

  const marker = (answer ?? "").trim();
  if (challenge.answerability === "answerable" && (marker === "[Abstain]" || marker === "[Refuse]"))
    fail("answerability=answerable but answer is an abstain/refuse marker");
  if (challenge.answerability === "unanswerable" && marker !== "[Abstain]")
    fail("answerability=unanswerable requires answer=[Abstain]");
  if ((challenge.answerability === "out_of_scope" || challenge.answerability === "disallowed") && marker !== "[Refuse]")
    fail("answerability=out_of_scope|disallowed requires answer=[Refuse]");
  if ((challenge.answerability === "out_of_scope" || challenge.answerability === "disallowed") && retrieval.searchExpectation !== "no_search_expected")
    fail("answerability=out_of_scope|disallowed requires search_expectation=no_search_expected");

  if (output.answerShape === "free_text" && challenge.answerability === "answerable") {
    const mt = deriveMatchType(output.answerShape, challenge.answerability, false);
    if (mt !== "judge") fail("answer_shape=free_text and answerable requires match_type=judge");
  }

  if (challenge.dataQuality === "dirty_enum" && !spec.diagnostics?.validationNote)
    fail("data_quality=dirty_enum requires diagnostics.validationNote explaining the messy field");

  for (const e of idEntities) {
    if ((relevantIds[e]?.length ?? 0) > 0 && !task.entities.includes(e) && !spec.diagnostics?.validationNote)
      fail(`relevant_ids has entity '${e}' not present in task.entities (no validationNote exception)`);
  }

  if (provenance.suite === "canonical_sample" && !(provenance.origin === "human_requirement" && provenance.stability === "locked"))
    fail("suite=canonical_sample requires origin=human_requirement and stability=locked");
  if (provenance.suite === "semantic_stress") {
    const modalityOk = retrieval.modality === "semantic" || retrieval.modality === "hybrid";
    if (!(challenge.answerability === "answerable" && retrieval.evaluation === "required" && modalityOk && challenge.semanticGap !== "none" && hasIds))
      fail("suite=semantic_stress requires answerable + retrieval.evaluation=required + modality semantic|hybrid + semantic_gap!=none + non-empty relevant_ids");
  }
  // Locked-case snapshot comparison (id/question/answer/relevant_ids) happens in the caller,
  // which has the actual snapshot store in scope; this function only validates taxonomy structure.
}
