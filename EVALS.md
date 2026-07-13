# Eval Suite

How we measure this agent. The goal is a small, reproducible eval set that represents realistic query patterns, stresses likely failure modes, and makes failures diagnosable. Not the largest possible case count: every case has a purpose, every failure is interpretable.

## The suite at a glance

50 core cases, split into four suites, plus 14 exploratory cases in the challenge bank:

| Suite | Count | What it protects |
|---|---|---|
| `core_deterministic` | 30 | Structured lookups, filters, aggregates, and search with answers computed from the frozen DB |
| `adversarial` | 8 | Injection, instruction override, prompt leak, roleplay jailbreaks, social engineering, scope escalation |
| `canonical_sample` | 7 | The human-provided requirement examples (`gold_sample_01..07`), kept exactly as worded |
| `semantic_stress` | 5 | Deliberately hard semantic cases (`gold_semantic_01..05`) whose evidence shares few words with the question |

The build throws above 50 core cases and warns above 45. At the cap, promoting a case means demoting or consolidating another. Challenge-bank cases never count toward the core aggregate and don't run by default.

Reports always show each suite separately before any global aggregate. A big easy deterministic suite must never hide a canonical-sample or semantic-stress failure. A low semantic-stress score is the finding, not a problem to paper over.

## Running

```
npm run eval                                       # full core suite, writes eval-report.json
npm run eval -- --filter <field>=<value>           # subset by any golden.jsonl field
npm run eval -- --limit 5                          # first N cases
npm run eval -- --only-retrieval | --only-answer   # score one axis
npm run eval -- --dataset src/eval/challenge-bank.jsonl
npm run eval:view                                  # render eval-report.json to a self-contained HTML file
npm run eval:build-golden                          # rebuild datasets from the builder
npm run eval:build-golden -- --update-snapshots    # refresh locked snapshots after a reviewed change
npm test                                           # unit tests (taxonomy validator, scorers, query builder, etc.)
```

## What gets scored

Every case supports two independent scores, plus performance counters (tool calls per question, and whether the 8-call cap was hit).

### Answer correctness

`match_type` picks the checker:

| `match_type` | Checker |
|---|---|
| `exact_scalar` | Normalized string equality |
| `numeric_exact` | Integer/float equality |
| `numeric_tolerance` | Within a stated absolute or percent tolerance |
| `boolean` | True/false equality |
| `set_equality` | Order-insensitive set equality |
| `ranked_list` | Order-sensitive list equality |
| `abstain` | Response begins with `[Abstain]` (in scope, corpus can't answer) |
| `refuse` | Response begins with `[Refuse]` (out of scope or disallowed) |
| `judge` | Rubric-based correctness/groundedness (manual for now) |

### Retrieval correctness

Did the system surface the minimum evidence needed to answer? The scorer grades returned IDs grouped by entity type. It's method-agnostic: it doesn't care whether the IDs came from BM25, vector search, or SQL.

Every case declares one `retrieval_evaluation` mode:

- `required`: score `relevant_ids` with recall and precision. MRR is scored too, but only when `retrieval.modality` is `lexical`, `semantic`, or `hybrid`. A `structured` case's predicted-id order is incidental row order, not a ranking, so its MRR is `null` rather than a fabricated score.
- `not_applicable`: excluded from retrieval metrics. The answer never depended on specific row IDs (e.g. a plain `COUNT(*)`).
- `trajectory_only`: not scored on recall/MRR now; reserved for a future "did it search before concluding" check. Used by the abstain cases.

`relevant_ids` holds only evidence that's genuinely necessary, never rows that are merely useful context. An empty `relevant_ids` means nothing on its own; `retrieval_evaluation` says how to read it.

## Generated files

All joined by `id`. Never hand-edit them; the builder is the single source of truth.

- `golden.jsonl`: core cases and scoring labels (question, answer, match_type, retrieval_evaluation, relevant_ids, optional multi-turn `messages`).
- `tuples.jsonl`: the taxonomy row for each core case.
- `challenge-bank.jsonl` / `challenge-tuples.jsonl`: exploratory and demoted cases.
- `locked-snapshots.json`: id to {question, answer, relevant_ids} for every locked case. The build fails if a locked case drifts from its snapshot.

## The builder

`src/eval/build-golden.ts` authors each case once via `emitCase(id, question, spec, answer, relevantIds, opts?)` and writes every dataset in one run. Deterministic answers and evidence come from the frozen DB through small SQL helpers (`sqlCount`, `sqlScalar`, `sqlSet`, `sqlRanked`, `sqlBoolean`), never invented. Fixed free-text answers exist only for judged cases and the requirement samples.

Three fields are always derived, never hand-set (`src/eval/taxonomy-rules.ts`): `match_type` (from answer shape + answerability), `source_grounding` (from modality), and `complexity_bucket` (from operation count).

A build-time validator rejects mechanically checkable contradictions: multi-turn without messages, a modality that disagrees with the required operations, `required` with empty ids, a locked case that drifted, a `semantic_stress` case that isn't actually semantic, and a dozen more. See `taxonomy-rules.ts` and its tests for the full list. It's not a theorem prover; `diagnostics.validationNote` documents the exceptions it can't infer.

Locked cases (`gold_sample_*`, `gold_semantic_*`) may have their taxonomy corrected freely, but id, question, reference answer, and hand-audited evidence only change via `--update-snapshots` after deliberate review. Never replace a locked case with a cleaner synthetic approximation; the exact wording is part of what it tests.

## Case taxonomy

Each tuples row keeps these groups conceptually separate. One overloaded "difficulty" field is exactly what we're avoiding.

**`provenance`**: why the case exists and how safely it can be rewritten. `suite` (above), `origin` (`human_requirement | human_authored | synthetic_handcrafted | generated | production_failure`), `stability` (`locked | editable`), `execution_tier` (`core | challenge_bank`).

**`task`**: what's being asked. `operation` is one of `lookup, filter_list, existence, aggregate, compare, rank, summarize, explain`. `scope` is `single_entity | multi_entity | corpus`. `entities` lists the tables the question semantically needs.

**`composition`**: how the question is built. `history` (`single_message | multi_turn`; multi-turn requires real prior `messages` and genuine ambiguity), `temporal_scope` (`none | absolute_date | date_range`; always fixed dates, the frozen corpus has no "last week"), and `required_operations`, the minimal steps to answer (`filter`, `join`, `semantic_match`, `aggregate`, ...). This is the main diagnostic layer; it localizes failures like "semantic retrieval works alone but fails combined with a join and two filters." `complexity_bucket` derives from its length: simple (1-2), compound (3-4), complex (5+).

**`retrieval`**: how the evidence is found. `modality` classifies the actual evidence path, not perceived difficulty: `none | structured | lexical | semantic | hybrid`. A `LIKE '%remediation%'` over a structured column is still `structured`; its messiness belongs under `data_quality`. Plus `evaluation` (above) and `search_expectation` (`not_needed | search_required | no_search_expected`).

**`challenge`**: what makes it hard. `answerability` (`answerable | unanswerable | out_of_scope | disallowed`), `distractor` (`none | near_miss_name | homonym | irrelevant`), `data_quality` (`clean | dirty_enum | json_field | conflicting_link`), `semantic_gap` (`none | synonym | paraphrase | implicit_concept | latent_theme | cross_document_pattern`), and `adversarial`, where each value names a distinct bypass technique (`prompt_injection`, `instruction_override`, `indirect_injection`, `prompt_leak`, `jailbreak_roleplay`, `social_engineering`, `scope_escalation`). Blunt injections mostly test the base model's training; the interesting ones test this system specifically, like whether the agent trusts a malicious instruction arriving via retrieved content.

**`output.answer_shape`**: `scalar | count | numeric | boolean | set | ranked_list | free_text`.

**`diagnostics`**: optional, non-scoring context for humans: `validationNote`, `baselineHypothesis` (semantic-stress only), freeform `tags`.

## Adding a case

1. Start from a failure hypothesis: a realistic way the agent can fail.
2. Ground it in the frozen DB with real values, dates, and evidence.
3. Compute answer and evidence with SQL/FTS for deterministic cases; fixed reference answers only for judged synthesis, only after human review.
4. Author the full `CaseSpec` explicitly. Don't copy another case's taxonomy by habit.
5. `npm run eval:build-golden`; let the validator reject contradictions.
6. Run it through the real agent and inspect the trace before trusting the label.

Admission rule: a case earns a core slot only if removing it would lose coverage of a requirement, a distinct capability, a known risky interaction, an observed regression, an architecture-discrimination test, or a distinct abstain/refuse/adversarial behavior. Two cases exercising the same operation, retrieval path, and failure mode get consolidated. Entity-name variation alone doesn't justify a second case.

Semantic-stress cases are built from the corpus outward: find a real supported theme in the artifacts, record positive and hard-negative evidence, write the question in natural abstraction rather than evidence text, and verify a human can defend exactly one answer. Low lexical overlap is evidence of a real semantic gap, not sufficient by itself. These cases aren't required to pass today; don't weaken one to make a baseline green.

## Data-quality guardrails

- **`implementations.status` is not a clean enum.** Roughly 33 free-text variants (`in progress`, `in-progress`, `stalled - ownership dispute`, ...). Bucket it first, or use it intentionally with `data_quality: dirty_enum` and auditable evidence ids.
- **Use absolute dates.** Artifacts span 2026-03-01 to 2026-03-20; implementations span 2020-2026.
- **JSON columns hide structure** (`strengths_json`, `contacts_json`, `features_json`, ...). Prefer flat columns for the discrete suite; label intentional cases `json_field`.
- **Artifact content can override misleading links.** `gold_0023` is the canonical example: the ticket's text names the affected product while its `product_id` points elsewhere. Only the artifact is required evidence.

## Real value sets for generation

Clean categorical enums safe for deterministic ground truth:

- `customers.industry`: Energy, SaaS, Retail, Public Sector, Manufacturing, Logistics, Hospitality, Financial Services, Education, Healthcare
- `customers.region`: Canada, Nordics, ANZ, North America West
- `customers.size_band`: Large Enterprise, Enterprise, Upper Mid-Market
- `customers.account_health`: healthy, recovering, at risk, expanding, watch list
- `customers.crm_stage`: implementation, active pilot, renewal review, new logo pursuit, expansion cycle, escalation recovery
- `artifacts.artifact_type`: competitor_research, customer_call, internal_communication, internal_document, support_ticket
- `implementations.deployment_model`: hybrid, multi-tenant SaaS, private cloud, single-tenant cloud
- `employees.department`: Engineering, Product, Support, Solutions Engineering, Security, Sales, Customer Success, Sales Operations, Leadership
- `employees.management_level`: Executive, Individual Contributor, Manager, Senior, Senior Individual Contributor

Numeric fields with exact answers: `customers.employee_count`, `implementations.contract_value`, `artifacts.token_estimate`.

Table sizes: artifacts 250, customers 50, scenarios 50, implementations 50, employees 23, competitors 8, products 4, company_profile 1.

## What's deliberately not built yet

- Judged free-text scoring (`openevals` or equivalent). The `judge` subset stays small and manual for now.
- Trajectory evaluation (which tools, in what order), including the `trajectory_only` retrieval check.
- Faithfulness checks comparing answer claims against retrieved evidence.
- Policy-aware eval personas. Evals currently run without a request context, which bypasses the tool gateway's authorize/audit path on purpose; once `authorize` has real rules, cases can declare a persona to run as.
