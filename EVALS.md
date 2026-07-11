# Eval Suite
Fleshes out the Evals design from DESIGN.md v0.

## Two eval axes, decoupled

Every golden record carries two independent scores:

1. **Retrieval (deterministic).** Did we surface the right evidence? Scored against `relevant_ids` (recall@k, precision, MRR). Method-agnostic (BM25, vector, hybrid): it grades the returned IDs, not how they were found. IDs are grouped by `entity_type`, so the score is independent of tool shape. A compound tool that returns three entity types just fills three keys; the scorer compares per `entity_type`, then rolls up.
2. **Answer (deterministic or judged).** Did the final answer match ground truth? Scored against `answer` via `match_type`. Structured lookups are deterministic; free-form synthesis uses an LLM judge.

A pair can score right-answer/wrong-retrieval or the reverse.

Generation lives in `src/eval/build-golden.ts` (`npm run eval:build-golden`). Questions and memory are handcrafted; every `answer` and `relevant_ids` is computed from the frozen DB, so the set can't drift and stays reproducible. Rows carry an optional `rationale` (ungraded): it doubles as the judge rubric for summaries and records why abstain/refuse rows decline.

## Staging: hand-roll deterministic now, offload to llm judge later

Deterministic first: retrieval (recall@k, precision, MRR over `relevant_ids`) and the structured answer checks (`exact_scalar`, `numeric_exact`/`numeric_tolerance`, `boolean`, `set_equality`, `ranked_list`, plus the `[Abstain]`/`[Refuse]` markers).

Judge later: free-form summaries (`answer_shape: free_text`) and any faithfulness/groundedness or trajectory scoring need an LLM judge, which means a rubric prompt and a verdict parser. That's its own stage (v7, subject to change). When it lands I'll use `openevals` (answer correctness / groundedness) and `agentevals` (tool-call trajectory) instead of writing judge prompts by hand. Until then we'll minimize the number of subjective samples that I'll grade by hand.

## Golden record shape

Two files joined by `id`. `golden.jsonl` holds query, answer, and scorer fields; the dimension tuple lives in `tuples.jsonl`. In order to generate useful synthetic Q&A data (ie: in `golden.jsonl`), I needed to taxonomize the different query dimensions.

```jsonc
// golden.jsonl
{
  "id": "gold_0001",
  "question": "How many customers are in the Energy industry?",
  "answer": "6",
  "match_type": "numeric_exact",
  "relevant_ids": { "customers": ["cust_..."] } // supporting ids grouped by entity_type; the retrieval label
  // optional: "tolerance", "messages" (multi-turn), "rationale" (ungraded: judge rubric / why we abstain)
}
```

```jsonc
// tuples.jsonl (one dimension tuple per id)
{
  "id": "gold_0001",
  "query_type": "numeric",
  "entities": ["customers"],
  "history": "single_message",
  "should_have_response": "answerable",
  "answer_shape": "count",
  "retrieval_modality": "structured",
  "temporal_scope": "none",
  "source_grounding": "structured_table",
  "distractor_present": "none"
}
```

For `unanswerable` or `refusal` rows, `match_type` is `abstain`. The system prompt tells the agent to open with `[Abstain]` when the DB has no answer, or `[Refuse]` for off-topic/adversarial asks. `answer` holds the expected marker, so the check stays deterministic. `relevant_ids` is `{}` (retrieving nothing is correct). This keeps human `judge` review to the few real summaries.

## Dimensions

### query_type
- `summary` - condense a set of artifacts or events
- `episodic` - what happened at a specific point or window
- `numeric` - a computed number
- `single_entity_analysis` - read on one named entity
- `multi_entity_analysis` - compare or rank across many entities

### entities
Core tables the question touches, one or more of:
`customers`, `competitors`, `company_profile`, `products`, `employees`,
`implementations`, `scenarios`, `artifacts`.

`company_profile` is a single row (the vendor). `artifacts` is first-class, not just evidence: `artifact_type` is one of the cleanest discrete surfaces in the DB.

### history
- `single_message` - self-contained question
- `multi_turn` - resolves only against earlier turns ("what about their renewal?")

### should_have_response
- `answerable` - evidence exists
- `unanswerable` - no evidence in the DB (expect an "I don't know" answer, empty `relevant_ids`)
- `refusal` - adversarial or out-of-scope (expect a refusal)

### answer_shape
Sets the checker (`match_type`), and is what makes answer eval deterministic.
- `scalar` - one name/string -> `exact_scalar`
- `count` - an integer -> `numeric_exact`
- `numeric` - a measured number -> `numeric_exact` or `numeric_tolerance`
- `boolean` - yes/no -> `boolean`
- `set` - unordered collection -> `set_equality`
- `ranked_list` - ordered collection -> `ranked_list`
- `free_text` - open synthesis -> `judge` (summaries / analysis) or `abstain` (unanswerable/refusal via the `[Abstain]`/`[Refuse]` marker). Only real summaries need human `judge` review; keep under 5 for the first pass, scale with an LLM judge later.

### retrieval_modality
Drives the v1-vs-v2 comparison.
- `structured` - answerable by filters/joins on columns
- `lexical` - keyword match over artifact text (FTS/BM25)
- `semantic` - driven by meaning, not keywords ("pricing anxiety")
- `hybrid` - needs both a structured filter and a meaning match

### temporal_scope
- `none`
- `absolute_date` - a fixed date or month
- `date_range` - between two dates

### source_grounding
Where the answer lives; predicts whether it's deterministically checkable, so bias toward `structured_table` for the discrete quota. Tracks `retrieval_modality` (`structured`->`structured_table`, `lexical`/`semantic`->`artifact_content`, `hybrid`->`mixed`) but stays an explicit label.
- `structured_table` - answer lives in columns
- `artifact_content` - answer lives in `content_text`
- `mixed` - needs both

### distractor_present
Ties the golden and adversarial sets together.
- `none`
- `near_miss_name` - a similarly named entity exists
- `dirty_enum` - the field has messy variants (see `implementations.status`)
- `homonym` - a term with two meanings in the corpus
- `irrelevant` - off-topic bait (Kanye's birthday)

## match_type reference

| match_type        | checker                                   |
|-------------------|-------------------------------------------|
| `exact_scalar`    | normalized string equality                |
| `numeric_exact`   | integer/float equality                    |
| `numeric_tolerance` | within a stated absolute or percent band |
| `boolean`         | true/false                                |
| `set_equality`    | order-insensitive set match on ids/values |
| `ranked_list`     | order-sensitive list match                |
| `abstain`         | response carries the expected marker (`[Abstain]` / `[Refuse]`) |
| `judge`           | LLM rubric (correct / grounded / complete)|

Retrieval is always scored on `relevant_ids`, regardless of `match_type`.

## Real value-sets for generation

Clean categorical enums (safe for deterministic ground truth):

- `customers.industry`: Energy, SaaS, Retail, Public Sector, Manufacturing, Logistics,
  Hospitality, Financial Services, Education, Healthcare
- `customers.region`: Canada, Nordics, ANZ, North America West
- `customers.size_band`: Large Enterprise, Enterprise, Upper Mid-Market
- `customers.account_health`: healthy, recovering, at risk, expanding, watch list
- `customers.crm_stage`: implementation, active pilot, renewal review, new logo pursuit,
  expansion cycle, escalation recovery
- `artifacts.artifact_type`: competitor_research, customer_call, internal_communication,
  internal_document, support_ticket (50 rows each)
- `implementations.deployment_model`: hybrid, multi-tenant SaaS, private cloud,
  single-tenant cloud
- `employees.department`: Engineering, Product, Support, Solutions Engineering, Security,
  Sales, Customer Success, Sales Operations, Leadership
- `employees.management_level`: Executive, Individual Contributor, Manager, Senior,
  Senior Individual Contributor

Numeric fields with exact answers: `customers.employee_count`,
`implementations.contract_value` (0 to 1,800,000), `artifacts.token_estimate`.

Table sizes: artifacts 250, customers 50, scenarios 50, implementations 50, employees 23,
competitors 8, products 4, company_profile 1.

## Data-quality guardrails

These break deterministic scoring if ignored.

- **`implementations.status` is not a clean enum.** ~33 free-text variants ("in progress" vs
  "in-progress" vs "stalled - ownership dispute"). Don't build count or filter ground truth on it
  directly. Bucket it first, or use it on purpose as a `dirty_enum` distractor.
- **Use absolute dates.** Artifacts sit in a tight 20-day window (2026-03-01 to 2026-03-20);
  implementations span 2020 to 2026. The real calendar date is later than every artifact, so
  "recent" or "last week" has no fixed meaning. Temporal questions use explicit dates or ranges.
- **JSON columns hide structure.** `strengths_json`, `contacts_json`, `success_metrics_json`,
  `features_json`, `domain_expertise_json`, `blueprint_json`, `metadata_json`. Answers from these
  are harder to grade. Prefer flat columns for the discrete set.

## Coverage targets (first pass)

Pairwise: every pair of values across dimensions co-occurs in at least one tuple.
- Skew answer toward deterministic shapes / `structured_table`; cap `free_text` under 5 rows.
- Every `query_type`, every clean enum entity, and both `history` values appear.
- Include `unanswerable` and `refusal` rows so "I don't know" behavior is tested.
- Seed a handful of `distractor_present` rows that overlap the adversarial set.

## Dimension spec

Value space for tuple generation. Each field is an enum; `entities` is multi-valued (>=1). `answer_shape` maps to `match_type` per the table above.

```jsonc
{
  "query_type":           ["summary", "episodic", "numeric", "single_entity_analysis", "multi_entity_analysis"],
  "entities":             ["customers", "competitors", "company_profile", "products",
                           "employees", "implementations", "scenarios", "artifacts"], // multi-valued, >=1
  "history":              ["single_message", "multi_turn"],
  "should_have_response": ["answerable", "unanswerable", "refusal"],
  "answer_shape":         ["scalar", "count", "numeric", "boolean", "set", "ranked_list", "free_text"], // -> match_type
  "retrieval_modality":   ["structured", "lexical", "semantic", "hybrid"],
  "temporal_scope":       ["none", "absolute_date", "date_range"],
  "source_grounding":     ["structured_table", "artifact_content", "mixed"],
  "distractor_present":   ["none", "near_miss_name", "dirty_enum", "homonym", "irrelevant"]
}
```

## Validity constraints

Rules the hand-authored tuples honor so no row is self-contradictory.

- `should_have_response = refusal` => `entities = []`, `answer_shape = free_text`,
  `retrieval_modality = semantic`, `source_grounding = artifact_content`,
  `distractor_present` in {`irrelevant`, `homonym`}.
- `should_have_response = unanswerable` => `relevant_ids` empty downstream; any modality allowed.
- `retrieval_modality` binds `source_grounding`: `structured`->`structured_table`,
  `lexical`|`semantic`->`artifact_content`, `hybrid`->`mixed`.
- `answer_shape = free_text` is capped at under 5 tuples total (overrides pairwise for that
  value; these are the judge / human-reviewed rows).
- `query_type = numeric` => `answer_shape` in {`count`, `numeric`, `boolean`, `ranked_list`}.
