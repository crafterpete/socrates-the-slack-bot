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
  | "judge";

export type QueryType =
  | "summary"
  | "episodic"
  | "numeric"
  | "single_entity_analysis"
  | "multi_entity_analysis";

export type AnswerShape =
  | "scalar"
  | "count"
  | "numeric"
  | "boolean"
  | "set"
  | "ranked_list"
  | "free_text";

export type RetrievalModality = "structured" | "lexical" | "semantic" | "hybrid";
export type TemporalScope = "none" | "absolute_date" | "date_range";
export type SourceGrounding = "structured_table" | "artifact_content" | "mixed";
export type DistractorPresent =
  | "none"
  | "near_miss_name"
  | "dirty_enum"
  | "homonym"
  | "irrelevant";

// The 9-dimension tuple. Lives in tuples.jsonl, joined to golden.jsonl by id.
export interface DimensionTuple {
  id: string;
  query_type: QueryType;
  entities: EntityType[];
  history: "single_message" | "multi_turn";
  should_have_response: "answerable" | "unanswerable" | "refusal";
  answer_shape: AnswerShape;
  retrieval_modality: RetrievalModality;
  temporal_scope: TemporalScope;
  source_grounding: SourceGrounding;
  distractor_present: DistractorPresent;
}

// The lean golden record. Scorer fields only; dimensions are joined in at load time.
export interface GoldenRecord {
  id: string;
  question: string;
  answer: string | null;
  match_type: MatchType;
  relevant_ids: GroupedIds;
  tolerance?: number;
  messages?: Array<{ role: "user" | "assistant"; content: string }>;
  rationale?: string;
  dims?: DimensionTuple;
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
