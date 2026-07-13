import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  AGGREGATE_FNS,
  describeEntities,
  ENTITY_NAMES,
  FACET_COLUMNS,
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
      "Columns to return; defaults to all. The entity's own id is always included (unless distinct " +
        "is true); list foreign-key columns explicitly if you need them.",
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
      "Requires `aggregate`. A plain string groups by a column on this entity. `{ via, column }` " +
        "groups by a column on the related entity that foreign key `via` points to, e.g. group " +
        "`implementations` by customer industry with `{ via: \"customer_id\", column: \"industry\" }` " +
        "rather than fetching both entities and reconciling them yourself. One hop only.",
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

const idFilter = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .describe("A single value, or a list of values matched as OR (SQL IN)");

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
      "Fuses meaning-based matching with exact-word matching, so results surface even when the artifact " +
        "uses different words than the query. Leave on; set false only for literal exact-term lookups " +
        "(e.g. an id-like token). Ignored by mode \"count\", which is always an exact occurrence count.",
    ),
  facet_by: z
    .enum(FACET_COLUMNS)
    .optional()
    .describe(
      "Adds a `facets` name-to-count rollup of every match in the set by this column, covering matches " +
        "beyond the returned rows. Use it for breadth questions with a modest `limit` instead of maxing " +
        "out rows: facet_by customer_id answers \"which customers...\" completely in a few tokens.",
    ),
  filters: z
    .object({
      customer_id: idFilter,
      product_id: idFilter,
      competitor_id: idFilter,
      artifact_type: idFilter,
      created_after: z.string().optional().describe("ISO date, inclusive lower bound on created_at"),
      created_before: z.string().optional().describe("ISO date, inclusive upper bound on created_at"),
    })
    .default({}),
  mode: z
    .enum(QUERY_MODES)
    .default("rows")
    .describe(
      "\"count\" returns an exact COUNT(*) of every matching artifact, unaffected by `limit`. Use it for " +
        "\"how many artifacts...\" questions; returned rows are capped, so never count those.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_LIMIT_MAX)
    .default(SEARCH_LIMIT_DEFAULT)
    .describe(
      `Rows returned (default ${SEARCH_LIMIT_DEFAULT}, max ${SEARCH_LIMIT_MAX}). Raise it only when ` +
        "you genuinely need that many rows (e.g. enumerating artifacts per candidate in a list-filter " +
        "scan); for breadth questions prefer `facet_by` with a modest limit. Every returned row costs " +
        "context, so keep it small when you expect a specific answer.",
    ),
});

export const databaseTools = [
  tool((args) => JSON.stringify(describeEntities(args.entities)), {
    name: "describe_entities",
    description:
      "Look up an entity's exact column names, its foreign keys (and the entity each points to), " +
      "and, for low-cardinality columns (e.g. account_health, industry, artifact_type), the exact " +
      "stored values under `enum_values`, so filter values never have to be guessed (\"at_risk\" vs " +
      "the real \"at risk\"). Call it before guessing column names or filter values on an entity you " +
      "haven't queried yet, and pass every uncertain entity in one call rather than one call each " +
      "(for a `group_by: { via, column }` hop, pass both the base entity and the one `via` points to).",
    schema: describeEntitiesSchema,
  }),
  tool((args) => JSON.stringify(queryEntities(args)), {
    name: "query_entities",
    description:
      `Filter, sort, count, or aggregate rows from one structured entity/table (${ENTITY_LIST_PROSE}). ` +
      "Use this for anything with a precise, complete answer: lookups, counts, existence checks, top-N " +
      "rankings, grouped aggregates. Foreign-key ids in results are automatically paired with display " +
      "names (customer_id comes with customer_name), so joins are never needed for readable names. To " +
      "filter on a related entity's property (e.g. artifacts of at-risk customers), query that entity " +
      "for its ids first, then pass them here with op \"in\". To aggregate by a related entity's column " +
      "(e.g. contract value by customer industry), use `group_by: { via, column }`.",
    schema: queryEntitiesSchema,
  }),
  tool(async (args) => JSON.stringify(await searchArtifacts(args)), {
    name: "search_artifacts",
    description:
      "Search artifact title/summary/content (customer calls, support tickets, competitor reports, " +
      "internal docs), most relevant first. Matches by exact wording (BM25) and by meaning, fused into " +
      "one ranking, so relevant artifacts surface even when their wording differs from the query. Use " +
      "for open-ended topic questions, not exact-match lookups. Filters scope the search (e.g. " +
      "customer_id from a prior query_entities call). Id filters accept a list: scan a known candidate " +
      "set (e.g. every ANZ customer) with one call, not one search per id, unless you need each " +
      "candidate's top matches individually. Results include `total_matches` and `truncated`: when " +
      "`truncated` is true, the rows are only the top slice of a larger matching set, so never describe " +
      "the pattern as small or exhaustive from the rows alone; quantify with `total_matches` (\"at " +
      "least N\") and use `facet_by` to see the full set grouped by customer/type/product/competitor. " +
      "For \"how many artifacts mention X\" questions, use mode \"count\" rather than counting returned " +
      "rows.",
    schema: searchArtifactsSchema,
  }),
];
