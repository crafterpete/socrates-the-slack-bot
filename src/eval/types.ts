export type EntityType =
  | "artifacts"
  | "customers"
  | "competitors"
  | "products"
  | "employees"
  | "implementations"
  | "scenarios"
  | "company_profile";

export type GroupedIds = Partial<Record<EntityType, string[]>>;

export type MatchType =
  | "exact_scalar"
  | "numeric_exact"
  | "numeric_tolerance"
  | "boolean"
  | "set_equality"
  | "ranked_list"
  | "abstain"
  | "refuse"
  | "judge";

// ---- Case taxonomy (see EVALS.md) -----------------------------------------------------------
// CaseSpec is authored in camelCase; the builder emits the snake_case CaseTuple shape below to
// tuples.jsonl. Every group is a conceptually separate axis; do not collapse them back into one
// overloaded field.

export type ProvenanceSuite =
  | "core_deterministic"
  | "canonical_sample"
  | "semantic_stress"
  | "adversarial"
  | "regression";
export type ProvenanceOrigin =
  | "human_requirement"
  | "human_authored"
  | "synthetic_handcrafted"
  | "generated"
  | "production_failure";
export type Stability = "locked" | "editable";
export type ExecutionTier = "core" | "challenge_bank";

export type TaskOperation =
  | "lookup"
  | "filter_list"
  | "existence"
  | "aggregate"
  | "compare"
  | "rank"
  | "summarize"
  | "explain";
export type TaskScope = "single_entity" | "multi_entity" | "corpus";

export type RequiredOperation =
  | "resolve_context"
  | "filter"
  | "join"
  | "date_filter"
  | "lexical_match"
  | "semantic_match"
  | "group"
  | "aggregate"
  | "sort"
  | "limit"
  | "deduplicate"
  | "synthesize";
export type Aggregation = "none" | "count" | "sum" | "average" | "min" | "max" | "other";
export type Ordering = "none" | "ascending" | "descending" | "ranked";
export type TemporalScope = "none" | "absolute_date" | "date_range";
export type ComplexityBucket = "simple" | "compound" | "complex";

export type RetrievalModality = "none" | "structured" | "lexical" | "semantic" | "hybrid";
export type RetrievalEvaluation = "required" | "not_applicable" | "trajectory_only";
export type SearchExpectation = "not_needed" | "search_required" | "no_search_expected";
export type SourceGrounding = "none" | "structured_table" | "artifact_content" | "mixed";

export type Answerability = "answerable" | "unanswerable" | "out_of_scope" | "disallowed";
export type Distractor = "none" | "near_miss_name" | "homonym" | "irrelevant";
export type DataQuality = "clean" | "dirty_enum" | "json_field" | "conflicting_link";
export type SemanticGap =
  | "none"
  | "synonym"
  | "paraphrase"
  | "implicit_concept"
  | "latent_theme"
  | "cross_document_pattern";
export type Adversarial =
  | "none"
  | "prompt_injection"
  | "instruction_override"
  | "indirect_injection"
  | "prompt_leak"
  | "jailbreak_roleplay"
  | "social_engineering"
  | "scope_escalation";

export type AnswerShape =
  | "scalar"
  | "count"
  | "numeric"
  | "boolean"
  | "set"
  | "ranked_list"
  | "free_text";

export interface BaselineHypothesis {
  structuredSql: "should_pass" | "likely_fail" | "not_applicable";
  ftsBm25: "should_pass" | "likely_fail" | "not_applicable";
  vector: "should_pass" | "likely_fail" | "not_applicable";
  hybrid: "should_pass" | "likely_fail" | "not_applicable";
}

// Authored shape. Passed by the builder to emitCase(); camelCase throughout.
export interface CaseSpec {
  provenance: {
    suite: ProvenanceSuite;
    origin: ProvenanceOrigin;
    stability: Stability;
    executionTier: ExecutionTier;
  };
  task: {
    operation: TaskOperation;
    scope: TaskScope;
    entities: EntityType[];
  };
  composition: {
    history: "single_message" | "multi_turn";
    temporalScope: TemporalScope;
    requiredOperations: RequiredOperation[];
    filterCount: number;
    joinCount: number;
    textPredicateCount: number;
    aggregation: Aggregation;
    ordering: Ordering;
  };
  retrieval: {
    modality: RetrievalModality;
    evaluation: RetrievalEvaluation;
    searchExpectation: SearchExpectation;
  };
  challenge: {
    answerability: Answerability;
    distractor: Distractor;
    dataQuality: DataQuality;
    semanticGap: SemanticGap;
    adversarial: Adversarial;
  };
  output: {
    answerShape: AnswerShape;
  };
  diagnostics?: {
    baselineHypothesis?: BaselineHypothesis;
    validationNote?: string;
  };
}

// Emitted shape. One row per case in tuples.jsonl; snake_case, nested groups plus derived fields.
export interface CaseTuple {
  id: string;
  provenance: {
    suite: ProvenanceSuite;
    origin: ProvenanceOrigin;
    stability: Stability;
    execution_tier: ExecutionTier;
  };
  task: {
    operation: TaskOperation;
    scope: TaskScope;
    entities: EntityType[];
  };
  composition: {
    history: "single_message" | "multi_turn";
    temporal_scope: TemporalScope;
    required_operations: RequiredOperation[];
    filter_count: number;
    join_count: number;
    text_predicate_count: number;
    aggregation: Aggregation;
    ordering: Ordering;
  };
  retrieval: {
    modality: RetrievalModality;
    evaluation: RetrievalEvaluation;
    search_expectation: SearchExpectation;
    source_grounding: SourceGrounding; // derived from retrieval.modality
  };
  challenge: {
    answerability: Answerability;
    distractor: Distractor;
    data_quality: DataQuality;
    semantic_gap: SemanticGap;
    adversarial: Adversarial;
  };
  output: {
    answer_shape: AnswerShape;
    match_type: MatchType; // derived from output.answer_shape + challenge.answerability
  };
  complexity_bucket: ComplexityBucket; // derived from composition.required_operations.length
  diagnostics?: {
    baseline_hypothesis?: BaselineHypothesis;
    validation_note?: string;
  };
}

// The lean golden record. Scorer fields only; the CaseTuple is joined in at load time under `dims`.
export interface GoldenRecord {
  id: string;
  question: string;
  answer: string | null;
  match_type: MatchType;
  retrieval_evaluation: RetrievalEvaluation;
  relevant_ids: GroupedIds;
  tolerance?: { absolute?: number; percent?: number };
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  rationale?: string;
  dims?: CaseTuple;
}

export interface ToolCall {
  name: string;
  input: string;
  output: string;
}

export interface AnswerScore {
  match_type: MatchType;
  correct: boolean | null;
  detail?: string;
}

export interface PerEntityRetrieval {
  found: number;
  gold: number;
  recall: number;
  precision: number;
}

export interface RetrievalScore {
  scored: boolean;
  recall: number;
  precision: number;
  mrr: number;
  perEntity: Record<string, PerEntityRetrieval>;
}

export interface EvalResult {
  id: string;
  question: string;
  answer: string;
  expected: string | null;
  answerScore: AnswerScore | null;
  retrievalScore: RetrievalScore | null;
  expectedIds: GroupedIds;
  predicted: GroupedIds;
  toolCallCount: number;
  toolCalls: ToolCall[];
}
