# Tools

## SQL Tooling

The agent has three parameterized tools for querying the database. No raw SQL, no free-text `sql` parameter.

### `describe_entities`

Returns one or more entities' exact column names, plus which of those columns are foreign keys and what entity each one points to. Column names aren't otherwise enumerated anywhere the model can see ahead of time, so this is how the model confirms a column exists (for `filters`, `select`, `order_by`, `group_by`) instead of guessing and retrying off an error message. It's also how it discovers valid `via` hops before using cross-table `group_by`. Takes an array so the model can describe every entity it's unsure about in one call rather than spending a tool call per table.

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

Full-text search over artifact titles/summaries/content (customer calls, support tickets, competitor reports, internal docs), ranked by relevance (BM25).

| Param | Notes |
|---|---|
| `query` | Search text |
| `exact_phrase` | Default `true` (exact phrase match); `false` matches rows containing all the words in any order |
| `filters` | Optional `customer_id`, `product_id`, `competitor_id`, `artifact_type`, `created_after`, `created_before` |
| `mode` | `"rows"` (default, ranked top-k) or `"count"`. Use `count` for "how many artifacts mention X" questions, since `rows` results are capped |
| `limit` | Default 5, max 15 (rows mode only) |

### Safety

- Every table name, column name, filter operator, and aggregate function is checked against a hardcoded allowlist *inside the query builder itself*, not just the tool's schema, so no raw SQL fragment the model writes ever reaches the database.
- Every filter value is bound as a SQL parameter, never string-interpolated.
- The database connection is read-only (`PRAGMA query_only = ON`) as a backstop.
- The agent is capped at 8 tool calls per question; once hit, it must answer (or abstain) with whatever it's already gathered instead of continuing indefinitely.
