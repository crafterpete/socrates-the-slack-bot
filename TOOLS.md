# Tools

## SQL Tooling

The agent has three parameterized tools for querying the database. No raw SQL, no free-text `sql` parameter.

### `describe_entities`

Returns one or more entities' exact column names, plus which of those columns are foreign keys and what entity each one points to. Column names aren't otherwise enumerated anywhere the model can see ahead of time, so this is how the model confirms a column exists (for `filters`, `select`, `order_by`, `group_by`) instead of guessing and retrying off an error message. It's also how it discovers valid `via` hops before using cross-table `group_by`. Takes an array so the model can describe every entity it's unsure about in one call rather than spending a tool call per table.

**`enum_values`.** For any column whose real, distinct values all fit within 20 (e.g. `account_health`, `industry`, `artifact_type`), the response includes the exact value set, sorted (numerically if the values are numeric). This is how the model gets a filter value's exact spelling/casing right on the first try instead of guessing (`"at_risk"` vs the real `"at risk"`) and burning a call discovering the truth. High-cardinality and free-text/JSON columns fall out of the cap naturally, no separate exclusion list needed. The entity's own id and any foreign-key column are excluded on purpose even if their cardinality is low, since a raw id list isn't meaningful without the related entity's names, use `foreign_keys` and a `via` hop or a follow-up `describe_entities` call instead.

| Param | Notes |
|---|---|
| `entities` | Array of entity names, same list as `query_entities`. At least one required |

### `query_entities`

Structured lookups, filters, counts, and aggregates over one table at a time.

| Param | Notes |
|---|---|
| `entity` | `customers`, `implementations`, `artifacts`, `employees`, `competitors`, `products`, `scenarios`, `company_profile` |
| `filters` | Array of `{ column, op, value }`, combined with AND. `op`: `eq, neq, gt, gte, lt, lte, like, in, between` |
| `select` | Columns to return (defaults to all) |
| `distinct` | Return only unique rows |
| `order_by` | `{ column, direction }` |
| `group_by` + `aggregate` | `aggregate: { fn: count\|sum\|avg\|min\|max, column? }`. `group_by` is a column name, or `{ via, column }` to group by a column on a directly related entity (see below). Grouped and ranked by the aggregate value |
| `mode` | `"rows"` (default) or `"count"`. `count` runs an exact `COUNT(*)` over the *entire* matching set, never capped by `limit` |
| `limit` | Default 20, max 50 |

Two things behave automatically so the model doesn't have to remember syntax:

- **`like` auto-wraps in wildcards.** A bare value like `"Acme"` is matched as `%Acme%` (substring), unless you already included `%`/`_` yourself.
- **A bare date upper bound covers the whole day.** `lte` or `between`'s second value of `"2026-03-20"` is treated as `2026-03-20T23:59:59`, so same-day timestamped rows aren't silently excluded.

**Foreign keys are auto-enriched.** Any `*_id` column in a result (e.g. `customer_id`) automatically comes with its display name attached (`customer_name`), so no join is needed just to show a readable name.

**No joins for filtering or row-fetching.** This tool only ever queries one table for that. To filter on a related entity's property (e.g. "artifacts belonging to at-risk customers"), query that entity first to get its ids, then pass them here with `op: "in"`.

**One exception: cross-table `group_by`.** `group_by: { via: "customer_id", column: "industry" }` groups `implementations` by the linked customer's industry in a single call, instead of fetching both entities and reconciling the numbers by hand. `via` must be an existing foreign-key column on the entity being queried (the same ones that get auto-enriched with a display name), and the hop only ever goes in the many-to-one direction (many implementations to one customer), so grouped aggregates can never double-count from a fan-out. It only reaches one hop; grouping by something two hops away (e.g. a scenario's competitor's segment) still needs a manual reconciliation step.

### `search_artifacts`

Hybrid search over artifact titles/summaries/content (customer calls, support tickets, competitor reports, internal docs). Each query runs two retrieval passes: a BM25 keyword match against the FTS5 table, and a semantic pass that embeds the query (OpenAI) and ranks artifacts by cosine similarity against precomputed artifact embeddings. The two rankings are fused with Reciprocal Rank Fusion (`RRF_K = 60`, Elasticsearch's default), so relevant artifacts surface even when their wording differs from the query.

Each side feeds only its top 30 candidates (`CANDIDATE_POOL_SIZE`) into the fusion. An artifact outside a side's top 30 gets no credit from that side, so each pass can abstain on candidates it ranks poorly instead of every filtered row collecting residual score.

The artifact embeddings live in a local sidecar file (`src/db/artifact_embeddings.bin` plus a manifest), rebuilt with `npm run db:build-embeddings`. Content fingerprints are checked against the live DB on load, so a stale sidecar fails loudly instead of silently ranking against drifted content.

| Param | Notes |
|---|---|
| `query` | Search text |
| `semantic` | Default `true` (hybrid). `false` runs pure BM25, meant only for literal exact-term lookups (e.g. an id-like token) |
| `exact_phrase` | Default `true` (exact phrase match); `false` matches rows containing all the words in any order. BM25 side only |
| `filters` | Optional `customer_id`, `product_id`, `competitor_id`, `artifact_type` (each takes a single value or a list, matched as SQL IN), plus `created_after` / `created_before` |
| `mode` | `"rows"` (default, fused top-k) or `"count"`. Use `count` for "how many artifacts mention X" questions, since `rows` results are capped |
| `limit` | Default 15, max 25 (rows mode only). List filters pair well with the max, so every candidate in a scanned set can surface its best match |

Three behaviors worth knowing:

- **Filters scope both sides.** BM25 applies them in SQL; the vector side only ranks artifacts that pass the structured filters. A `customer_id` list means one search call can scan a whole candidate set instead of one call per id.
- **`count` mode is always pure BM25.** Cosine similarity has no match/no-match threshold, so there's nothing principled to count on the semantic side. Counts are exact keyword-occurrence counts.
- **Snippets fall back to summaries.** Rows that matched on keywords return the BM25 match window as their snippet. Rows surfaced only by the vector side never had an FTS match, so `snippet()` can't run and the artifact's summary is returned instead.

### Safety

- Every table name, column name, filter operator, and aggregate function is checked against a hardcoded allowlist *inside the query builder itself*, not just the tool's schema, so no raw SQL fragment the model writes ever reaches the database.
- Every filter value is bound as a SQL parameter, never string-interpolated.
- The database connection is read-only (`PRAGMA query_only = ON`) as a backstop.
- The agent is capped at 8 tool calls per question; once hit, it must answer (or abstain) with whatever it's already gathered instead of continuing indefinitely.

## Tool gateway (auth + audit)

The agent never binds the raw tools. `withToolGateway` (`src/agent/gateway.ts`) wraps each one, and every call the model makes passes through the wrapper. The split is deliberate: the LLM only ever picks a tool name and arguments; trusted code decides whether that call runs and records that it did.

- **Request context.** Each Slack message's user id, channel, and thread ts get attached to the agent run (`requestConfig`) and travel through the LangGraph config to every tool call in that run. The model never sees or supplies identity; it rides alongside the conversation, not inside it.
- **`authorize(context, toolName, args)`.** Stubbed today: everyone can run everything, which is fine while the tools are read-only and the users are trusted channel members. Throwing from it denies the call, and the error text is surfaced to the model so it can tell the user. In a production system this would consult a real permissions layer, and the interesting checks are argument-level (constraining which rows a user's queries may touch), not just tool-level.
- **Audit.** One structured JSON line per call: user, channel, tool, args, row count, duration, and the error if one was thrown. In production these would ship to logging infra (Splunk, Datadog); locally they go to stdout.
- **Internal callers bypass it.** Calls carrying no request context (the eval harness, unit tests) run the tool untouched and unaudited. Only requests that arrived through Slack get authorized and logged.
