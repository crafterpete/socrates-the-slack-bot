# Eval Suite

This document defines the eval-case taxonomy, golden-set build pattern, and scoring semantics
for the Northstar Signal agent.

The goal is not to generate every possible combination of labels. The goal is a small,
reproducible eval set that represents realistic query patterns, stresses likely failure modes,
and makes failures diagnosable.

## Design principles

1. **The builder is the single source of truth.** `src/eval/build-golden.ts` owns the question,
   case specification, answer provenance, and evidence labels. Running `npm run eval:build-golden`
   writes `golden.jsonl` / `tuples.jsonl` (core) and `challenge-bank.jsonl` / `challenge-tuples.jsonl`
   (demoted/exploratory) in one run. The builder never reads a separately hand-maintained tuples
   file back in.
2. **Questions and case intent are authored together.** A case's taxonomy describes the question
   and the actual retrieval/computation path used to establish its ground truth.
3. **Answers and evidence come from the frozen DB.** Deterministic answers and `relevant_ids` are
   computed from `synthetic_startup.sqlite`, not invented. Fixed free-text answers are used only
   for judged cases and official reference samples.
4. **Query pattern, difficulty, and scorer configuration are separate concepts.** No single
   overloaded field represents all three.
5. **Derived fields are generated, not independently authored.** `match_type`, `source_grounding`,
   and `complexity_bucket` are always derived (`src/eval/taxonomy-rules.ts`), never hand-set.
6. **Coverage is constrained and risk-weighted.** Cases are not forced into invalid or artificial
   tuples merely to fill out a cross-product.
7. **A build-time validator rejects obvious contradictions.** Metadata that says `semantic` while
   the case is a pure structured SQL lookup is a build error, not an acceptable reporting label.
8. **Canonical human-authored cases are preserved, not regenerated away.** `gold_sample_*` and
   `gold_semantic_*` are durable benchmark assets, snapshot-protected (`locked-snapshots.json`).
9. **Some evals should expose current architectural limits.** The suite is not required to be
   immediately passable by the structured-SQL or FTS baseline. Semantic stress cases deliberately
   reveal where structured SQL, lexical matching, and semantic/vector retrieval differ.
10. **The default regression suite stays small.** Target 40-45 core cases; hard cap under 50.
    Additional generated or exploratory cases live in the challenge bank until they prove they add
    unique diagnostic value.

## Evaluation axes

Every case supports two independent scores.

### 1. Answer correctness

| `match_type` | Checker |
|---|---|
| `exact_scalar` | Normalized string equality |
| `numeric_exact` | Integer/float equality |
| `numeric_tolerance` | Within a stated absolute or percent tolerance |
| `boolean` | True/false equality |
| `set_equality` | Order-insensitive set equality |
| `ranked_list` | Order-sensitive list equality |
| `abstain` | Response begins with `[Abstain]` |
| `refuse` | Response begins with `[Refuse]` |
| `judge` | Rubric-based correctness/groundedness/completeness (manual for now) |

`abstain` and `refuse` are separate match types and report separately: abstain means the request
is in scope but the corpus doesn't support an answer; refuse means the request is out of scope,
disallowed, or attempts to override the system's task.

### 2. Retrieval correctness

Did the system surface the minimum evidence required to answer? Retrieval is method-agnostic:
the scorer grades returned IDs grouped by entity type, not whether the implementation used
BM25, vector search, SQL, or a compound tool.

Every case declares one `retrieval_evaluation` mode:

- `required`: score `relevant_ids` with recall and precision. MRR is also scored, but only when
  `retrieval.modality` is `lexical`, `semantic`, or `hybrid` — the predicted-ids order only
  reflects a real relevance ranking (BM25's `ORDER BY rank`) for those; a `structured`-only case's
  predicted-ids order is just incidental tool-call/row order, not a ranking signal, so MRR is
  `null` (not applicable) rather than a fabricated score.
- `not_applicable`: excluded from retrieval metrics. The answer can be computed without the
  final tool output exposing specific row IDs (e.g. a plain `COUNT(*)`).
- `trajectory_only`: not scored on recall/MRR now, but reserved for a future check of whether
  the system searched before answering or abstaining (currently used for the abstain cases: the
  agent should look before concluding there's no data).

`relevant_ids` holds only evidence that's genuinely necessary, never rows that are merely useful
context. Whether a row is "necessary" is decided at authoring time, per case:

- `How many customers are in Energy?` — a clean structured aggregate; individual customer IDs
  aren't required in the final result → `not_applicable`.
- `Which competitors are Direct rivals?` — names specific rows → `required` with the matching ids.
- `How many implementations are in a remediation-related status?` — a messy free-text field
  (`implementations.status`); keep the matched ids and use `required` so they can be audited.

An empty `relevant_ids` never carries all these meanings implicitly — `retrieval_evaluation`
determines how the scorer interprets it.

## Staging

Deterministic first (implemented now):
- Answer checks for scalar, numeric, boolean, set, ranked-list, abstain, and refuse.
- Retrieval metrics only where `retrieval_evaluation = required`.
- Metrics segmented by suite (below), not one blended aggregate.

Judged later (not yet implemented):
- Free-text answer correctness and groundedness, via `openevals` or an equivalent judge.
- Search/tool trajectory evaluation, via `agentevals` or an equivalent.
- Faithfulness checks comparing claims against retrieved evidence.

The hand-reviewed `judge` subset stays small by design; `canonical_sample` and `semantic_stress`
cases are exempt from that quota since they're judged deliberately, not as overflow.

## Eval suites and provenance

Every case carries provenance so reporting and future refactors distinguish ordinary synthetic
coverage from durable human-authored benchmarks.

- `core_deterministic`: hand-authored or generated cases with answers computed from the frozen
  DB and deterministic scorers where possible.
- `canonical_sample`: the human-provided requirement examples, `gold_sample_01` through
  `gold_sample_07`. Acceptance tests for the product-level behavior the system should ultimately
  support — kept exactly as worded, even when the current implementation doesn't yet pass them.
- `semantic_stress`: deliberately difficult, answerable cases (`gold_semantic_01..05`) whose
  evidence is lexically divergent, implicit, or distributed across artifacts. Their purpose is to
  expose retrieval-architecture gaps, not to pass today — a low score here is the useful signal,
  not a problem to paper over.
- `adversarial`: prompt injection, instruction override, and off-topic cases.
- `regression`: cases promoted from an observed production or eval failure. A regression case may
  also carry tags like `semantic_stress` or `dirty_enum`, but has one primary suite.

Provenance fields (`tuples.jsonl`):

```jsonc
{
  "provenance": {
    "suite": "semantic_stress",
    "origin": "human_authored",
    "stability": "locked",
    "execution_tier": "core"
  }
}
```

- `origin`: `human_requirement | human_authored | synthetic_handcrafted | generated | production_failure`.
- `stability`: `locked | editable`.
- `execution_tier`: `core | challenge_bank`.

Rules:
- `gold_sample_*` cases use `suite: canonical_sample`, `origin: human_requirement`, `stability: locked`.
- `gold_semantic_*` cases use `suite: semantic_stress`, `origin: human_authored`, `stability: locked`.
- Locked cases may have their taxonomy corrected freely, but their id, question, reference answer,
  and hand-audited `relevant_ids` are snapshot-tested (`locked-snapshots.json`, refreshed only via
  `npm run eval:build-golden -- --update-snapshots` after a deliberate, reviewed change).
- Never replace a locked case with a cleaner synthetic approximation — its exact wording and
  complexity are part of what it tests.
- Reports show each suite separately before any global aggregate. A large easy deterministic
  suite must never hide a canonical-sample or semantic-stress failure.

## Core-suite size and case lifecycle

The default regression suite stays intentionally small: the goal is a compact portfolio where
every case has a clear purpose and every failure is interpretable, not the largest possible count.

- Target 40-45 core cases; hard cap under 50 (49 max) — the build throws at 50+ and warns above 45.
- `canonical_sample` and locked `semantic_stress` cases always count toward the cap.
- Current: 49 core (29 `core_deterministic`, 8 `adversarial`, 7 `canonical_sample`,
  5 `semantic_stress`) + 14 in the challenge bank. At the 49-case hard-cap ceiling; promoting
  another case requires demoting or retiring one first.

### Admission rule

A case belongs in the core suite only when removing it would eliminate coverage of at least one
of: a product-level requirement; a distinct retrieval or reasoning capability; a known high-risk
interaction between capabilities; a previously observed regression; a deliberate
architecture-discrimination test; a materially different abstain/refusal/adversarial behavior.

Two cases exercising the same operation, retrieval path, and failure mode should usually be
consolidated unless they protect separate human requirements. Entity-name or enum-value variation
alone doesn't justify a second core case.

At the cap, adding a core case requires one of: removing a weaker duplicate; consolidating
several narrow cases into one compound case; or demoting an existing editable case to the
challenge bank. Locked human-authored cases are never automatically evicted.

### Challenge bank

`execution_tier: challenge_bank` holds exploratory or lower-confidence cases: demoted editable
ordinary cases (preserved, not deleted, when the core suite is pruned), generated pairwise
combinations, newly proposed semantic questions awaiting review, rare entity/value combinations,
and candidate regressions not yet reproduced. It has no strict size target, never contributes to
the core aggregate, and doesn't run by default (`npm run eval -- --dataset src/eval/challenge-bank.jsonl`).

Promote a challenge-bank case to core only after its answer/evidence is human-audited, it exposes
a reproducible failure or uniquely missing capability, its purpose is documented, and it isn't
redundant with an existing core case.

### Reporting

Report the core suite by capability and provenance before any single aggregate:

```text
core_deterministic (28)   answer: 27/28 pass   retrieval: recall 91% · precision 84% (16 scored)
adversarial (2)           answer: 2/2 pass
canonical_sample (7)      answer: deferred to judge (7)
semantic_stress (5)       answer: deferred to judge (5)   retrieval: recall 12% (5 scored)

overall core (42)         answer: 29/30 deterministic pass
```

A low semantic-stress retrieval score stays visible rather than being diluted by the easy
structured rows. Challenge-bank results are reported separately and never merged into the
headline score.

## Generated files

All files are joined by `id`.

- `golden.jsonl` — core user-facing cases and scoring labels. Fewer than 50 rows.
- `tuples.jsonl` — taxonomy rows for the same core cases.
- `challenge-bank.jsonl` / `challenge-tuples.jsonl` — exploratory/demoted cases, excluded from the
  default regression run.
- `locked-snapshots.json` — id → {question, answer, relevant_ids} for every locked case; the
  build-time drift check compares against this.

### `golden.jsonl`

```jsonc
{
  "id": "gold_0012",
  "question": "How many customers are in the Energy industry?",
  "answer": "6",
  "match_type": "numeric_exact",
  "retrieval_evaluation": "not_applicable",
  "relevant_ids": {}
  // optional: "tolerance": { "absolute": 0.01 }, "messages": [...], "rationale": "..."
}
```

### `tuples.jsonl`

```jsonc
{
  "id": "gold_0012",
  "provenance": { "suite": "core_deterministic", "origin": "synthetic_handcrafted", "stability": "editable", "execution_tier": "core" },
  "task": { "operation": "aggregate", "scope": "corpus", "entities": ["customers"] },
  "composition": {
    "history": "single_message", "temporal_scope": "none",
    "required_operations": ["filter", "aggregate"],
    "filter_count": 1, "join_count": 0, "text_predicate_count": 0,
    "aggregation": "count", "ordering": "none"
  },
  "retrieval": { "modality": "structured", "evaluation": "not_applicable", "search_expectation": "not_needed", "source_grounding": "structured_table" },
  "challenge": { "answerability": "answerable", "distractor": "none", "data_quality": "clean", "semantic_gap": "none", "adversarial": "none" },
  "output": { "answer_shape": "count", "match_type": "numeric_exact" },
  "complexity_bucket": "simple"
}
```

## Case taxonomy

The taxonomy is an eval-case schema, not just a query taxonomy — its groups stay conceptually
separate.

### `provenance`

Why the case exists and how safely it may be rewritten (see "Eval suites and provenance" above).
Not a difficulty label.

### `task.operation`

What the user is asking the system to produce:

- `lookup` — retrieve one scalar fact about a named entity or the company.
- `filter_list` — return an unordered set matching constraints.
- `existence` — determine whether any matching row/evidence exists.
- `aggregate` — compute a count, sum, average, min/max, or other aggregate.
- `compare` — contrast two or more named entities without a full ranking.
- `rank` — return an ordered list based on an explicit criterion.
- `summarize` — condense a body of evidence or events.
- `explain` — synthesize causes, themes, risks, strengths/weaknesses, or a recommendation.

Temporal behavior and numeric output are not operations — a date-bounded question stays whatever
operation it is, with a non-`none` `temporal_scope`; a numeric answer is `aggregate` +
`output.answer_shape`.

### `task.scope`

- `single_entity` — one named customer, product, implementation, competitor, employee, or the
  company profile.
- `multi_entity` — compares, ranks, or groups a bounded set of entities.
- `corpus` — scans or aggregates across the full relevant dataset.

### `task.entities`

Which tables/entity types the question semantically needs:
`customers`, `competitors`, `company_profile`, `products`, `employees`, `implementations`,
`scenarios`, `artifacts`. Describes semantic participation, not every table touched incidentally —
e.g. a join used only to resolve a customer's name may still list both `implementations` and
`customers` when both are necessary to express and score the answer.

### `composition.history`

- `single_message` — self-contained.
- `multi_turn` — genuinely ambiguous or incomplete without prior `messages`. Attaching unrelated
  memory does not make a case multi-turn; the validator rejects a `single_message` case whose
  question opens with an obviously unresolved pronoun/referent.

### `composition.temporal_scope`

- `none` / `absolute_date` (one explicit date/month/quarter/year) / `date_range` (explicit bounds).
  Always fixed dates — the frozen corpus has no meaningful "recent" or "last week".

### `composition.required_operations`

The minimal operations needed to answer: `resolve_context`, `filter`, `join`, `date_filter`,
`lexical_match`, `semantic_match`, `group`, `aggregate`, `sort`, `limit`, `deduplicate`,
`synthesize`. This is the main diagnostic layer — it identifies failures like "semantic retrieval
works alone, but fails when combined with a join and two structured filters."

Also tracked: `filter_count`, `join_count`, `text_predicate_count`, `aggregation`
(`none|count|sum|average|min|max|other`), `ordering` (`none|ascending|descending|ranked`).

`complexity_bucket` is derived from `required_operations.length`: `simple` (1-2), `compound`
(3-4), `complex` (5+).

### `retrieval.modality`

How the required evidence is found — classify the actual evidence path, not the perceived
difficulty of the question:

- `none` — no corpus retrieval should occur.
- `structured` — filters, joins, grouping, or aggregation over structured columns. A
  `LIKE '%remediation%'` predicate over `implementations.status` is still structured retrieval;
  its difficulty belongs under `challenge.data_quality = dirty_enum`, not the modality.
- `lexical` — exact-token/phrase matching over artifact text (FTS/BM25).
- `semantic` — matching by meaning where the evidence doesn't share the important query terms.
- `hybrid` — structured constraints plus lexical or semantic text matching.

### `retrieval.evaluation` / `retrieval.search_expectation`

See "Evaluation axes" above. `search_expectation`: `not_needed | search_required | no_search_expected`.

### `retrieval.source_grounding`

Derived from `retrieval.modality`, never authored independently: `none→none`,
`structured→structured_table`, `lexical|semantic→artifact_content`, `hybrid→mixed`.

### `challenge.answerability`

- `answerable` → normal answer.
- `unanswerable` (in scope, corpus doesn't support it) → `[Abstain]`, `match_type: abstain`.
- `out_of_scope` / `disallowed` (unrelated, or should be refused for policy/security reasons) →
  `[Refuse]`, `match_type: refuse`.

### `challenge.distractor`

`none | near_miss_name | homonym | irrelevant`.

### `challenge.data_quality`

- `clean`
- `dirty_enum` — inconsistent free-text variants for the same conceptual state (e.g.
  `implementations.status`). Requires a `diagnostics.validationNote` explaining the messy field.
- `json_field` — the answer depends on structure embedded in a JSON column.
- `conflicting_link` — linked structured metadata conflicts with the authoritative artifact
  content. `gold_0023` is the canonical example: the support ticket's text names the affected
  product, but its `product_id` foreign key points elsewhere. Only the artifact is required
  evidence, not the FK'd row.

### `challenge.semantic_gap`

How far the question's wording is from the evidence's wording:

- `none` — direct structured lookup or substantial keyword overlap.
- `synonym` — different but near-equivalent terms.
- `paraphrase` — same proposition, materially different language.
- `implicit_concept` — requires recognizing an unstated concept (e.g. mapping a discount plus
  procurement pressure to "price-driven competitive pull").
- `latent_theme` — a theme (impatience, risk, operational friction) expressed through several
  different symptoms rather than one shared phrase.
- `cross_document_pattern` — the concept emerges only by combining evidence across multiple
  artifacts or entities.

Valid only with a defensible, hand-audited ground truth — an under-specified question with
several plausible answers is unanswerable or needs a clearer question, not a semantic label.

### `challenge.adversarial`

`none | prompt_injection | instruction_override | indirect_injection | prompt_leak |
jailbreak_roleplay | social_engineering | scope_escalation`. Kept independent of retrieval
modality or distractor — an injection attempt is not encoded as a homonym.

Each value names a distinct bypass technique, not just "is this case adversarial":
`prompt_injection`/`instruction_override` are blunt, direct-phrasing attempts (e.g. "ignore your
instructions") — useful as a baseline, but passing them mostly confirms the underlying model's
RLHF training, not this system's specific defenses. The others test failure modes specific to
this agent: `indirect_injection` (a malicious instruction arrives via retrieved/prior-turn
content rather than the live user message — does the agent trust it?), `prompt_leak` (a direct
attempt to extract the system prompt/tool definitions), `jailbreak_roleplay` (a persona/fiction
wrapper around an otherwise-ordinary off-topic ask), `social_engineering` (a false-authority claim
paired with a request that should be declined regardless of who's asking), `scope_escalation`
(an invitation to exceed the agent's intended tool/data boundary — note this can pair with
`challenge.answerability: answerable`, since the correct response may be an accurate, bounded
answer rather than a refusal, e.g. truthfully listing the real schema instead of fabricating
"hidden" tables).

### `output.answer_shape`

`scalar | count | numeric | boolean | set | ranked_list | free_text`. `match_type` is always
derived from this plus `challenge.answerability` (`src/eval/taxonomy-rules.ts`), never hand-set:
`scalar→exact_scalar`, `count→numeric_exact`, `numeric→numeric_exact` (or `numeric_tolerance` with
an explicit tolerance), `boolean→boolean`, `set→set_equality`, `ranked_list→ranked_list`,
`free_text`+answerable`→judge`; any shape + `unanswerable`→`abstain`; any shape +
`out_of_scope|disallowed`→`refuse`.

### `diagnostics`

Optional, non-authoritative metadata. None of these fields affect scoring or `validateCase`
(except that `data_quality=dirty_enum` requires a `validationNote` to exist, see above); they
exist to make a case's *purpose* legible to a human reading the dataset or the report UI.

- `validationNote` — free-text prose explaining a structural exception the validator can't infer
  on its own (a documented `relevant_ids` entity exception, a messy `dirty_enum` field, etc.).
- `baselineHypothesis` — per-retrieval-strategy pass/fail prediction, `semantic_stress` cases only.
- `tags` — short kebab/snake_case labels for grouping/filtering cases by what capability they
  stress (e.g. `join_stress`, `cross_table_enrichment`, `complex_math`), surfaced in the report UI.
  Freeform and additive: unlike the rest of the taxonomy, there's no fixed enum and no requirement
  to tag every case, add them where they make a case easier to find or explain, skip them
  otherwise.

## Builder pattern

`src/eval/build-golden.ts` authors each case once via `emitCase(id, question, spec, answer,
relevantIds, opts?)`, where `spec` is a `CaseSpec` (camelCase; see `src/eval/types.ts`). `emitCase`
derives `match_type`/`source_grounding`/`complexity_bucket`, validates the case
(`src/eval/taxonomy-rules.ts`), checks it against `locked-snapshots.json` if locked, and appends
it to the core or challenge-bank output based on `provenance.executionTier`. Small SQL helpers
(`sqlCount`, `sqlScalar`, `sqlSet`, `sqlRanked`, `sqlBoolean`) compute `{answer, ids}` from the
frozen DB; `mkSpec()` fills in sensible defaults for the boilerplate fields while still requiring
`task.operation`, `task.entities`, `retrieval.modality`, `retrieval.evaluation`, and
`output.answerShape` explicitly per case.

### Build-time validation

The build throws on (see `src/eval/taxonomy-rules.ts` and its tests in `src/eval/__tests__/`):
`history=multi_turn` without `messages`; a `single_message` question opening with an unresolved
pronoun; `temporal_scope` and `date_filter` presence disagreeing; `retrieval.modality` disagreeing
with its required text/structured operations; `modality=none` with non-empty `relevant_ids`;
`evaluation=required`/`not_applicable` disagreeing with `relevant_ids` emptiness;
`search_expectation=no_search_expected` without `modality=none`; `answerability` disagreeing with
the `[Abstain]`/`[Refuse]` marker; `answer_shape=free_text`+answerable without `match_type=judge`;
`data_quality=dirty_enum` without a `validationNote`; a `relevant_ids` entity absent from
`task.entities` without a documented exception; `suite=canonical_sample` without
`origin=human_requirement`+`locked`; `suite=semantic_stress` without all of {answerable,
`evaluation=required`, modality semantic/hybrid, `semantic_gap≠none`, non-empty `relevant_ids`};
a locked case whose id/question/answer/`relevant_ids` drifted from its snapshot; 50+ core cases.

This is not a natural-language theorem prover — it catches obvious, mechanically-checkable
contradictions only. A `diagnostics.validationNote` documents cases the validator can't infer on
its own (e.g. a deliberate entity exception).

## Adding a new case

1. Start from a failure hypothesis: a realistic way the agent can fail (missing a filter,
   near-name confusion, semantic+date combo, answering without searching, over-refusing, ...).
2. Ground it in the frozen DB: pick real entity values, dates, and evidence that make it true.
3. Compute the answer and evidence with SQL/FTS for deterministic cases; use a fixed reference
   answer only for judged synthesis, and only after human review.
4. Author the full `CaseSpec` explicitly — don't reuse another case's taxonomy by habit.
5. Run `npm run eval:build-golden`; let the validator reject contradictions.
6. Run the case through the real agent (`npm run eval -- --filter <field>=<value>`) and inspect
   the trace before trusting the label.

### Adding a semantic-stress case specifically

Build from the corpus outward, not from an abstract question:
1. Inspect a real cluster of artifacts and identify a supported latent concept or recurring theme.
2. Record the positive evidence ids and any plausible hard-negative ids (near-miss entities).
3. Write the question using a natural abstraction, not evidence text copied verbatim.
4. Verify a human can defend one answer and explain why hard negatives don't qualify.
5. Check lexical overlap between the question and the evidence — low overlap is useful evidence
   of a real semantic gap, but not sufficient by itself; the answer must still be defensible.
6. Add the case only after the reference answer and evidence set are human-reviewed.

A semantic-stress case is not required to pass today. `diagnostics.baselineHypothesis` records
why the case was added, not a required score — measure actual recall/MRR/answer correctness per
retrieval baseline (structured SQL, FTS/BM25, semantic/vector, hybrid) rather than asserting one.
Don't weaken a case to make a baseline green; a low score is the finding.

## Coverage strategy

Track constrained pairwise coverage (only compatible pairs) over: operation × modality, operation
× answerability, operation × answer_shape, modality × temporal_scope, modality × distractor,
history × scope, scope × complexity_bucket, data_quality × operation. Every `task.operation` and
`task.scope` should appear at least once; every core entity type in at least one answerable case;
structured/lexical/semantic/hybrid/none modalities all represented; both `history` values, with
`multi_turn` only where genuinely needed; simple/compound/complex composition buckets represented;
answerable/unanswerable/refusal behavior all present.

Report slices by: operation, scope, retrieval modality, complexity bucket, answerability, temporal
scope, data quality, distractor/adversarial condition, provenance suite, semantic gap, retrieval
baseline configuration.

## Real value sets for generation

Clean categorical enums safe for deterministic ground truth:

- `customers.industry`: Energy, SaaS, Retail, Public Sector, Manufacturing, Logistics,
  Hospitality, Financial Services, Education, Healthcare
- `customers.region`: Canada, Nordics, ANZ, North America West
- `customers.size_band`: Large Enterprise, Enterprise, Upper Mid-Market
- `customers.account_health`: healthy, recovering, at risk, expanding, watch list
- `customers.crm_stage`: implementation, active pilot, renewal review, new logo pursuit,
  expansion cycle, escalation recovery
- `artifacts.artifact_type`: competitor_research, customer_call, internal_communication,
  internal_document, support_ticket
- `implementations.deployment_model`: hybrid, multi-tenant SaaS, private cloud, single-tenant cloud
- `employees.department`: Engineering, Product, Support, Solutions Engineering, Security, Sales,
  Customer Success, Sales Operations, Leadership
- `employees.management_level`: Executive, Individual Contributor, Manager, Senior, Senior
  Individual Contributor

Numeric fields with exact answers: `customers.employee_count`, `implementations.contract_value`,
`artifacts.token_estimate`.

Table sizes: artifacts 250, customers 50, scenarios 50, implementations 50, employees 23,
competitors 8, products 4, company_profile 1.

## Data-quality guardrails

- **`implementations.status` is not a clean enum.** ~33 free-text variants (`in progress`,
  `in-progress`, `stalled - ownership dispute`, ...). Bucket it first, or use it intentionally with
  `data_quality: dirty_enum` and auditable evidence ids.
- **Use absolute dates.** Artifacts span 2026-03-01 to 2026-03-20; implementations span 2020-2026.
  Relative dates have no stable meaning against the frozen DB.
- **JSON columns hide structure**: `strengths_json`, `contacts_json`, `success_metrics_json`,
  `features_json`, `domain_expertise_json`, `blueprint_json`, `metadata_json`. Prefer flat columns
  for the discrete suite; label intentional cases `data_quality: json_field`.
- **Artifact content can override misleading links.** When the answer lives in `content_text`,
  require the artifact as evidence and don't automatically require every linked row too.
