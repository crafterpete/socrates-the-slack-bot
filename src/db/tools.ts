import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  AGGREGATE_FNS,
  describeEntities,
  ENTITY_NAMES,
  FILTER_OPS,
  queryEntities,
  QUERY_MODES,
  ROWS_LIMIT_DEFAULT,
  ROWS_LIMIT_MAX,
  searchArtifacts,
  SEARCH_LIMIT_DEFAULT,
  SEARCH_LIMIT_MAX,
  SORT_DIRECTIONS,
} from "./query-builder.js";

const ENTITY_ENUM = z.enum(ENTITY_NAMES);
const ENTITY_LIST_PROSE = ENTITY_NAMES.join(", ");

const FILTER_SCHEMA = z.object({
  column: z.string().describe("Column name to filter on"),
  op: z.enum(FILTER_OPS),
  value: z
    .union([z.string(), z.number(), z.array(z.union([z.string(), z.number()]))])
    .describe("A single value, except for \"in\" (array of values) and \"between\" (array of exactly 2 values)"),
});

const describeEntitiesSchema = z.object({
  entities: z.array(ENTITY_ENUM).min(1).describe("One or more entities to describe in a single call"),
});

const queryEntitiesSchema = z.object({
  entity: ENTITY_ENUM,
  filters: z.array(FILTER_SCHEMA).default([]).describe("Multiple filters are combined with AND"),
  distinct: z.boolean().default(false),
  select: z
    .array(z.string())
    .optional()
    .describe(
      "Columns to return; defaults to all columns on the entity. The entity's own id is always " +
        "included regardless of this list (unless distinct is true) — include a foreign-key " +
        "column explicitly if you also need it.",
    ),
  order_by: z.object({ column: z.string(), direction: z.enum(SORT_DIRECTIONS) }).optional(),
  group_by: z
    .union([
      z.string(),
      z.object({
        via: z
          .string()
          .describe("A foreign-key column on this entity (e.g. customer_id) to hop through"),
        column: z.string().describe("The column to group by on the related entity that `via` points to"),
      }),
    ])
    .optional()
    .describe(
      "Requires `aggregate` to also be set. A plain string groups by a column on this entity. " +
        "Use `{ via, column }` to group by a column on a directly related entity instead — e.g. " +
        "group `implementations` by the linked customer's industry with " +
        "`{ via: \"customer_id\", column: \"industry\" }` — instead of fetching both entities and " +
        "reconciling them yourself. Only works one hop through an existing foreign key.",
    ),
  aggregate: z
    .object({
      fn: z.enum(AGGREGATE_FNS),
      column: z.string().optional().describe("Required unless fn is \"count\""),
    })
    .optional(),
  mode: z
    .enum(QUERY_MODES)
    .default("rows")
    .describe("\"count\" returns an exact COUNT(*) over the full matching set, unaffected by `limit`"),
  limit: z.number().int().min(1).max(ROWS_LIMIT_MAX).default(ROWS_LIMIT_DEFAULT),
});

const searchArtifactsSchema = z.object({
  query: z.string(),
  exact_phrase: z
    .boolean()
    .default(true)
    .describe("true matches the query as an exact phrase; false matches rows containing all the words in any order"),
  semantic: z
    .boolean()
    .default(true)
    .describe(
      "Fuses in meaning-based matching alongside exact-word matching (reciprocal rank fusion), so results " +
        "surface even when the artifact uses different words than the query. Leave this on by default; only " +
        "set false for a rare exact-term-only lookup (e.g. matching a literal id-like token). Does not apply " +
        "to mode \"count\", which is always an exact textual-occurrence count.",
    ),
  filters: z
    .object({
      customer_id: z.string().optional(),
      product_id: z.string().optional(),
      competitor_id: z.string().optional(),
      artifact_type: z.string().optional(),
      created_after: z.string().optional().describe("ISO date, inclusive lower bound on created_at"),
      created_before: z.string().optional().describe("ISO date, inclusive upper bound on created_at"),
    })
    .default({}),
  mode: z
    .enum(QUERY_MODES)
    .default("rows")
    .describe(
      "\"count\" returns an exact COUNT(*) of every matching artifact, unaffected by `limit` — use this for " +
        "\"how many artifacts...\" questions instead of counting returned rows, since those are capped",
    ),
  limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).default(SEARCH_LIMIT_DEFAULT),
});

export const databaseTools = [
  tool((args) => JSON.stringify(describeEntities(args.entities)), {
    name: "describe_entities",
    description:
      "Look up the exact column names on one or more entities/tables in a single call, which of " +
      "those columns are foreign keys (and which entity each one points to), and, for columns with " +
      "a small enough set of distinct values (e.g. account_health, industry, artifact_type), the " +
      "exact real values themselves under `enum_values` — so a filter's `value` never has to be " +
      "guessed (\"at_risk\" vs the real \"at risk\") or discovered the expensive way via a failed " +
      "filter or a group_by probe. Pass every entity you're unsure about together rather than one " +
      "call per entity, e.g. when checking a `group_by: { via, column }` hop, pass both the base " +
      "entity and the entity `via` points to at once. Call this before guessing at column names or " +
      "filter values on an entity you haven't already queried in this conversation.",
    schema: describeEntitiesSchema,
  }),
  tool((args) => JSON.stringify(queryEntities(args)), {
    name: "query_entities",
    description:
      `Filter, sort, count, or aggregate rows from one structured entity/table (${ENTITY_LIST_PROSE}). ` +
      "Use this for anything with a precise, complete answer: lookups, counts, existence checks, top-N " +
      "rankings, grouped aggregates. Any foreign-key id in the result (e.g. customer_id) is automatically " +
      "paired with its display name (customer_name), so joins are never needed just to show a readable " +
      "name. To filter on a related entity's property (e.g. artifacts belonging to at-risk customers), " +
      "first query that entity to get its ids, then pass them to this tool with op \"in\". To aggregate " +
      "grouped by a related entity's column (e.g. total implementation contract value by customer " +
      "industry), use `group_by: { via, column }` instead of fetching both entities and reconciling the " +
      "numbers yourself.",
    schema: queryEntitiesSchema,
  }),
  tool(async (args) => JSON.stringify(await searchArtifacts(args)), {
    name: "search_artifacts",
    description:
      "Search over artifact title/summary/content (customer calls, support tickets, competitor reports, " +
      "internal docs), most relevant first. Matches both by exact wording (BM25) and by meaning, fused " +
      "into one ranking, so it finds relevant artifacts even when they use different words than the " +
      "query. Use this for open-ended topic questions rather than exact-match lookups. Optionally scope " +
      "the search with filters (e.g. customer_id from a prior query_entities call) to search within one " +
      "entity's artifacts. For \"how many artifacts mention X\" questions, use mode \"count\" rather than " +
      "counting returned rows.",
    schema: searchArtifactsSchema,
  }),
];
