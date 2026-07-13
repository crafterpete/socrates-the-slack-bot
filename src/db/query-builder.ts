import { getDatabase } from "./client.js";
import { embedQuery, rankBySimilarity } from "./embeddings.js";

export const ENTITY_NAMES = [
  "customers",
  "implementations",
  "artifacts",
  "employees",
  "competitors",
  "products",
  "scenarios",
  "company_profile",
] as const;

export type EntityName = (typeof ENTITY_NAMES)[number];

export const FILTER_OPS = ["eq", "neq", "gt", "gte", "lt", "lte", "like", "in", "between"] as const;
export type FilterOp = (typeof FILTER_OPS)[number];

export const AGGREGATE_FNS = ["count", "sum", "avg", "min", "max"] as const;
export type AggregateFn = (typeof AGGREGATE_FNS)[number];

export const QUERY_MODES = ["rows", "count"] as const;
export type QueryMode = (typeof QUERY_MODES)[number];

export const SORT_DIRECTIONS = ["asc", "desc"] as const;
export type SortDirection = (typeof SORT_DIRECTIONS)[number];

export type FilterValue = string | number | Array<string | number>;

export interface Filter {
  column: string;
  op: FilterOp;
  value: FilterValue;
}

export interface Aggregate {
  fn: AggregateFn;
  column?: string;
}

export interface GroupByVia {
  via: string;
  column: string;
}

export interface QueryEntitiesArgs {
  entity: EntityName;
  filters?: Filter[];
  distinct?: boolean;
  select?: string[];
  order_by?: { column: string; direction: SortDirection };
  group_by?: string | GroupByVia;
  aggregate?: Aggregate;
  mode?: QueryMode;
  limit?: number;
}

export const FACET_COLUMNS = ["customer_id", "product_id", "competitor_id", "artifact_type"] as const;
export type FacetColumn = (typeof FACET_COLUMNS)[number];

export interface SearchArtifactsArgs {
  query: string;
  exact_phrase?: boolean;
  semantic?: boolean;
  facet_by?: FacetColumn;
  filters?: {
    customer_id?: string | string[];
    product_id?: string | string[];
    competitor_id?: string | string[];
    artifact_type?: string | string[];
    created_after?: string;
    created_before?: string;
  };
  mode?: QueryMode;
  limit?: number;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  ids: Record<string, string[]>;
  total_matches?: number;
  truncated?: boolean;
  facets?: Record<string, number>;
}

// This functions as an allowlist of tables and columns the agent can interact with.
const ENTITY_SCHEMA: Record<EntityName, { table: string; pk: string; columns: string[] }> = {
  customers: {
    table: "customers",
    pk: "customer_id",
    columns: [
      "customer_id", "scenario_id", "name", "industry", "subindustry", "region", "country",
      "size_band", "employee_count", "annual_revenue_band", "crm_stage", "tech_stack_summary",
      "account_health", "primary_contact_name", "primary_contact_email", "contacts_json", "notes",
    ],
  },
  implementations: {
    table: "implementations",
    pk: "implementation_id",
    columns: [
      "implementation_id", "scenario_id", "customer_id", "product_id", "deployment_model",
      "status", "kickoff_date", "go_live_date", "contract_value", "scope_summary",
      "success_metrics_json", "risks_json",
    ],
  },
  artifacts: {
    table: "artifacts",
    pk: "artifact_id",
    columns: [
      "artifact_id", "scenario_id", "customer_id", "product_id", "competitor_id", "artifact_type",
      "title", "created_at", "summary", "content_text", "token_estimate", "content_fingerprint",
      "metadata_json",
    ],
  },
  employees: {
    table: "employees",
    pk: "employee_id",
    columns: [
      "employee_id", "full_name", "email", "title", "department", "region", "management_level",
      "domain_expertise_json", "writing_style",
    ],
  },
  competitors: {
    table: "competitors",
    pk: "competitor_id",
    columns: ["competitor_id", "name", "segment", "description", "pricing_position", "strengths_json", "weaknesses_json"],
  },
  products: {
    table: "products",
    pk: "product_id",
    columns: [
      "product_id", "name", "category", "description", "target_persona", "pricing_model",
      "deployment_modes_json", "core_use_cases_json", "features_json",
    ],
  },
  scenarios: {
    table: "scenarios",
    pk: "scenario_id",
    columns: [
      "scenario_id", "created_at", "blueprint_seed", "uniqueness_key", "industry", "region",
      "company_size_band", "primary_product_id", "secondary_product_id", "primary_competitor_id",
      "trigger_event", "pain_point", "scenario_summary", "blueprint_json", "status",
    ],
  },
  company_profile: {
    table: "company_profile",
    pk: "company_id",
    columns: [
      "company_id", "name", "category", "headquarters", "founding_year", "mission",
      "ideal_customer_profile", "architecture_summary", "compliance_posture", "pricing_overview",
      "differentiation",
    ],
  },
};

export const PK_TO_ENTITY: Record<string, EntityName> = Object.fromEntries(
  (Object.entries(ENTITY_SCHEMA) as [EntityName, { pk: string }][]).map(([entity, s]) => [s.pk, entity]),
);

const FK_ENRICHMENT: Record<string, { entity: EntityName; nameColumn: string }> = {
  customer_id: { entity: "customers", nameColumn: "name" },
  product_id: { entity: "products", nameColumn: "name" },
  competitor_id: { entity: "competitors", nameColumn: "name" },
  primary_product_id: { entity: "products", nameColumn: "name" },
  secondary_product_id: { entity: "products", nameColumn: "name" },
  primary_competitor_id: { entity: "competitors", nameColumn: "name" },
  employee_id: { entity: "employees", nameColumn: "full_name" },
};

export interface EntitySchemaInfo {
  entity: EntityName;
  columns: string[];
  foreign_keys: { column: string; references: EntityName }[];
  enum_values: Record<string, string[]>;
}

const ENUM_VALUE_CAP = 20;
const ENUM_VALUE_MAX_LEN = 60;

function isScalarLabel(v: string): boolean {
  return v.length <= ENUM_VALUE_MAX_LEN && !/^[[{]/.test(v.trim());
}

function sampleEnumValues(entity: EntityName): Record<string, string[]> {
  const db = getDatabase();
  const schema = ENTITY_SCHEMA[entity];
  const result: Record<string, string[]> = {};
  for (const column of schema.columns) {
    if (column === schema.pk || FK_ENRICHMENT[column]) continue;
    const rows = db
      .prepare(`SELECT DISTINCT ${column} AS v FROM ${schema.table} WHERE ${column} IS NOT NULL LIMIT ?`)
      .all(ENUM_VALUE_CAP + 1) as { v: unknown }[];
    if (rows.length === 0 || rows.length > ENUM_VALUE_CAP) continue;
    const values = rows.map((r) => String(r.v));
    if (!values.every(isScalarLabel)) continue;
    result[column] = values.sort((a, b) => {
      const na = Number(a);
      const nb = Number(b);
      return !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : a.localeCompare(b);
    });
  }
  return result;
}

export function describeEntity(entity: EntityName): EntitySchemaInfo {
  const schema = ENTITY_SCHEMA[entity];
  if (!schema) {
    throw new Error(`Unknown entity "${entity}". Valid entities: ${Object.keys(ENTITY_SCHEMA).join(", ")}`);
  }
  const foreign_keys = schema.columns.flatMap((column) => {
    const fk = column === schema.pk ? undefined : FK_ENRICHMENT[column];
    return fk ? [{ column, references: fk.entity }] : [];
  });
  return { entity, columns: schema.columns, foreign_keys, enum_values: sampleEnumValues(entity) };
}

export function describeEntities(entities: EntityName[]): EntitySchemaInfo[] {
  return entities.map((entity) => describeEntity(entity));
}

function validateColumn(entity: EntityName, column: string): void {
  const schema = ENTITY_SCHEMA[entity];
  if (!schema.columns.includes(column)) {
    throw new Error(
      `Unknown column "${column}" for entity "${entity}". Valid columns: ${schema.columns.join(", ")}`,
    );
  }
}

const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeUpperBound(value: FilterValue): FilterValue {
  return typeof value === "string" && BARE_DATE.test(value) ? `${value}T23:59:59` : value;
}

function compileWhere(
  entity: EntityName,
  filters: Filter[],
  alias?: string,
): { clause: string; params: unknown[] } {
  const prefix = alias ? `${alias}.` : "";
  const parts: string[] = [];
  const params: unknown[] = [];
  for (const f of filters) {
    validateColumn(entity, f.column);
    const col = `${prefix}${f.column}`;
    switch (f.op) {
      case "eq":
        parts.push(`${col} = ?`);
        params.push(f.value);
        break;
      case "neq":
        parts.push(`${col} != ?`);
        params.push(f.value);
        break;
      case "gt":
        parts.push(`${col} > ?`);
        params.push(f.value);
        break;
      case "gte":
        parts.push(`${col} >= ?`);
        params.push(f.value);
        break;
      case "lt":
        parts.push(`${col} < ?`);
        params.push(f.value);
        break;
      case "lte":
        parts.push(`${col} <= ?`);
        params.push(normalizeUpperBound(f.value));
        break;
      case "like": {
        const raw = f.value;
        const value =
          typeof raw === "string" && !raw.includes("%") && !raw.includes("_") ? `%${raw}%` : raw;
        parts.push(`${col} LIKE ?`);
        params.push(value);
        break;
      }
      case "in": {
        const values = Array.isArray(f.value) ? f.value : [f.value];
        if (values.length === 0) {
          parts.push("0");
          break;
        }
        parts.push(`${col} IN (${values.map(() => "?").join(",")})`);
        params.push(...values);
        break;
      }
      case "between": {
        const range = Array.isArray(f.value) ? f.value : [];
        const [low, high] = range;
        if (range.length !== 2 || low === undefined || high === undefined) {
          throw new Error(`"between" requires an array of exactly 2 values for column "${f.column}"`);
        }
        parts.push(`${col} BETWEEN ? AND ?`);
        params.push(low, normalizeUpperBound(high));
        break;
      }
    }
  }
  return { clause: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

const ALLOWED_AGGREGATE_FNS = new Set<string>(AGGREGATE_FNS);

function aggregateExpr(entity: EntityName, agg: Aggregate, alias?: string): string {
  if (!ALLOWED_AGGREGATE_FNS.has(agg.fn)) {
    throw new Error(`Unknown aggregate function "${agg.fn}". Valid: ${[...ALLOWED_AGGREGATE_FNS].join(", ")}`);
  }
  const fn = agg.fn.toUpperCase();
  if (fn === "COUNT" && !agg.column) return "COUNT(*) AS value";
  if (!agg.column) {
    throw new Error(`aggregate.column is required for "${agg.fn}"`);
  }
  validateColumn(entity, agg.column);
  const prefix = alias ? `${alias}.` : "";
  return `${fn}(${prefix}${agg.column}) AS value`;
}

function isGroupByVia(groupBy: string | GroupByVia): groupBy is GroupByVia {
  return typeof groupBy === "object" && groupBy !== null;
}

function resolveGroupByVia(entity: EntityName, groupBy: GroupByVia): { targetEntity: EntityName } {
  const schema = ENTITY_SCHEMA[entity];
  if (!schema.columns.includes(groupBy.via)) {
    throw new Error(`"${groupBy.via}" is not a column on entity "${entity}"`);
  }
  const fk = FK_ENRICHMENT[groupBy.via];
  if (!fk) {
    throw new Error(
      `"${groupBy.via}" is not a foreign key that can be hopped through. Valid: ${Object.keys(FK_ENRICHMENT).join(", ")}`,
    );
  }
  validateColumn(fk.entity, groupBy.column);
  return { targetEntity: fk.entity };
}

function enrichRows(entity: EntityName, rows: Record<string, unknown>[]): Record<string, unknown>[] {
  if (!rows.length) return rows;
  const db = getDatabase();
  const ownPk = ENTITY_SCHEMA[entity].pk;
  const idsByFk = new Map<string, Set<string>>();
  for (const row of rows) {
    for (const fk of Object.keys(FK_ENRICHMENT)) {
      if (fk === ownPk) continue;
      const v = row[fk];
      if (typeof v === "string") {
        const ids = idsByFk.get(fk) ?? new Set<string>();
        ids.add(v);
        idsByFk.set(fk, ids);
      }
    }
  }
  if (!idsByFk.size) return rows;

  const nameByFk = new Map<string, Map<string, string>>();
  for (const [fk, idSet] of idsByFk) {
    const enrichment = FK_ENRICHMENT[fk];
    if (!enrichment) continue;
    const { entity: targetEntity, nameColumn } = enrichment;
    const target = ENTITY_SCHEMA[targetEntity];
    const ids = [...idSet];
    const sql = `SELECT ${target.pk} AS id, ${nameColumn} AS name FROM ${target.table} WHERE ${target.pk} IN (${ids.map(() => "?").join(",")})`;
    const found = db.prepare(sql).all(...ids) as { id: string; name: string }[];
    nameByFk.set(fk, new Map(found.map((f) => [f.id, f.name])));
  }

  return rows.map((row) => {
    const out = { ...row };
    for (const [fk, idMap] of nameByFk) {
      const v = row[fk];
      if (typeof v === "string") {
        const name = idMap.get(v);
        if (name !== undefined) out[fk.replace(/_id$/, "_name")] = name;
      }
    }
    return out;
  });
}

function collectIds(entity: EntityName, rows: Record<string, unknown>[]): Record<string, string[]> {
  const pk = ENTITY_SCHEMA[entity].pk;
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const val = row[pk];
    if (typeof val !== "string" || seen.has(val)) continue;
    seen.add(val);
    ids.push(val);
  }
  return ids.length ? { [entity]: ids } : {};
}

export const ROWS_LIMIT_DEFAULT = 20;
export const ROWS_LIMIT_MAX = 50;

export function queryEntities(args: QueryEntitiesArgs): QueryResult {
  const schema = ENTITY_SCHEMA[args.entity];
  if (!schema) {
    throw new Error(`Unknown entity "${args.entity}". Valid entities: ${Object.keys(ENTITY_SCHEMA).join(", ")}`);
  }
  const db = getDatabase();
  const filters = args.filters ?? [];
  const { clause, params } = compileWhere(args.entity, filters);
  const limit = Math.max(1, Math.min(args.limit ?? ROWS_LIMIT_DEFAULT, ROWS_LIMIT_MAX));

  if (args.group_by || args.aggregate) {
    if (!args.aggregate) {
      throw new Error("aggregate is required when group_by is set");
    }
    const direction = args.order_by?.direction === "asc" ? "ASC" : "DESC";

    if (args.group_by && isGroupByVia(args.group_by)) {
      const { via, column } = args.group_by;
      const { targetEntity } = resolveGroupByVia(args.entity, args.group_by);
      const targetSchema = ENTITY_SCHEMA[targetEntity];
      const aggExpr = aggregateExpr(args.entity, args.aggregate, "base");
      const { clause: joinedClause, params: joinedParams } = compileWhere(args.entity, filters, "base");
      const sql = `
        SELECT related.${column} AS group_key, ${aggExpr}
        FROM ${schema.table} AS base
        JOIN ${targetSchema.table} AS related ON base.${via} = related.${targetSchema.pk}
        ${joinedClause}
        GROUP BY related.${column}
        ORDER BY value ${direction}
        LIMIT ?`;
      const rows = db.prepare(sql).all(...joinedParams, limit) as Record<string, unknown>[];
      return { rows, ids: {} };
    }

    const aggExpr = aggregateExpr(args.entity, args.aggregate);
    if (args.group_by) {
      validateColumn(args.entity, args.group_by);
      const sql = `SELECT ${args.group_by} AS group_key, ${aggExpr} FROM ${schema.table} ${clause} GROUP BY ${args.group_by} ORDER BY value ${direction} LIMIT ?`;
      const rows = db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
      return { rows, ids: {} };
    }
    const sql = `SELECT ${aggExpr} FROM ${schema.table} ${clause}`;
    const row = db.prepare(sql).get(...params) as Record<string, unknown>;
    return { rows: [row], ids: {} };
  }

  if (args.mode === "count") {
    const sql = `SELECT COUNT(*) AS value FROM ${schema.table} ${clause}`;
    const row = db.prepare(sql).get(...params) as Record<string, unknown>;
    return { rows: [row], ids: {} };
  }

  const requestedCols = args.select?.length ? args.select : schema.columns;
  requestedCols.forEach((c) => validateColumn(args.entity, c));

  const idCols = args.distinct ? [] : [schema.pk];
  const selectCols = [...new Set([...requestedCols, ...idCols])];

  let sql = `SELECT ${args.distinct ? "DISTINCT " : ""}${selectCols.join(", ")} FROM ${schema.table} ${clause}`;
  if (args.order_by) {
    validateColumn(args.entity, args.order_by.column);
    sql += ` ORDER BY ${args.order_by.column} ${args.order_by.direction === "desc" ? "DESC" : "ASC"}`;
  }
  sql += ` LIMIT ?`;
  const rows = db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
  const enriched = args.distinct ? rows : enrichRows(args.entity, rows);
  return { rows: enriched, ids: collectIds(args.entity, enriched) };
}

export const SEARCH_LIMIT_DEFAULT = 15;
export const SEARCH_LIMIT_MAX = 25;

// Top-k window each retrieval side feeds into RRF fusion — wider than the agent-facing limit.
// Applies to both sides symmetrically: BM25's top hits, and the vector side's nearest neighbors.
// Candidates outside a side's window get no credit from it, so each side can abstain on
// candidates it ranks poorly instead of every filtered row collecting residual vector score.
const CANDIDATE_POOL_SIZE = 30;
// Standard IR/RRF constant (also Elasticsearch's default).
const RRF_K = 60;

type ArtifactFilters = NonNullable<SearchArtifactsArgs["filters"]>;

function compileArtifactFilters(filters: ArtifactFilters | undefined, alias?: string): { clause: string; params: unknown[] } {
  const prefix = alias ? `${alias}.` : "";
  const parts: string[] = [];
  const params: unknown[] = [];
  const f = filters ?? {};
  const addScoped = (column: string, value: string | string[] | undefined) => {
    if (!value || (Array.isArray(value) && value.length === 0)) return;
    if (Array.isArray(value)) {
      parts.push(`${prefix}${column} IN (${value.map(() => "?").join(",")})`);
      params.push(...value);
    } else {
      parts.push(`${prefix}${column} = ?`);
      params.push(value);
    }
  };
  addScoped("customer_id", f.customer_id);
  addScoped("product_id", f.product_id);
  addScoped("competitor_id", f.competitor_id);
  addScoped("artifact_type", f.artifact_type);
  if (f.created_after) {
    parts.push(`${prefix}created_at >= ?`);
    params.push(f.created_after);
  }
  if (f.created_before) {
    parts.push(`${prefix}created_at <= ?`);
    params.push(normalizeUpperBound(f.created_before));
  }
  return { clause: parts.join(" AND "), params };
}

// Keys are display names when the facet column is a foreign key (via FK_ENRICHMENT), raw values
// otherwise (artifact_type). Rows with a NULL facet value are excluded, so counts can sum to less
// than total_matches.
function labelFacets(column: FacetColumn, counts: { v: string; n: number }[]): Record<string, number> {
  const fk = FK_ENRICHMENT[column];
  if (!fk || counts.length === 0) return Object.fromEntries(counts.map((r) => [r.v, r.n]));
  const schema = ENTITY_SCHEMA[fk.entity];
  const nameRows = getDatabase()
    .prepare(
      `SELECT ${schema.pk} AS id, ${fk.nameColumn} AS name FROM ${schema.table} WHERE ${schema.pk} IN (${counts.map(() => "?").join(",")})`,
    )
    .all(...counts.map((r) => r.v)) as { id: string; name: string }[];
  const nameById = new Map(nameRows.map((r) => [r.id, r.name]));
  return Object.fromEntries(counts.map((r) => [nameById.get(r.v) ?? r.v, r.n]));
}

function facetCandidates(facetBy: FacetColumn, candidateIds: string[]): Record<string, number> {
  if (!candidateIds.length) return {};
  const counts = getDatabase()
    .prepare(
      `SELECT ${facetBy} AS v, COUNT(*) AS n FROM artifacts ` +
        `WHERE artifact_id IN (${candidateIds.map(() => "?").join(",")}) AND ${facetBy} IS NOT NULL ` +
        `GROUP BY v ORDER BY n DESC`,
    )
    .all(...candidateIds) as { v: string; n: number }[];
  return labelFacets(facetBy, counts);
}

function compileMatchExpr(args: SearchArtifactsArgs): string {
  const quote = (text: string): string => `"${text.replace(/"/g, '""')}"`;
  if (args.exact_phrase !== false) return quote(args.query);
  const terms = args.query.split(/\s+/).filter((t) => /[\p{L}\p{N}]/u.test(t));
  return terms.length ? terms.map(quote).join(" ") : quote(args.query);
}

function compileSearchWhere(args: SearchArtifactsArgs): { clause: string; params: unknown[] } {
  const matchExpr = compileMatchExpr(args);
  const { clause: filterClause, params: filterParams } = compileArtifactFilters(args.filters, "a");
  const clause = `WHERE artifacts_fts MATCH ?${filterClause ? ` AND ${filterClause}` : ""}`;
  return { clause, params: [matchExpr, ...filterParams] };
}

async function searchArtifactsHybrid(
  args: SearchArtifactsArgs,
  limit: number,
): Promise<{ rows: Record<string, unknown>[]; totalMatches: number; facets?: Record<string, number> }> {
  const db = getDatabase();

  const { clause: bm25Clause, params: bm25Params } = compileSearchWhere(args);
  const bm25Rows = db
    .prepare(`SELECT a.artifact_id AS id FROM artifacts_fts f JOIN artifacts a ON a.artifact_id = f.artifact_id ${bm25Clause} ORDER BY rank LIMIT ?`)
    .all(...bm25Params, CANDIDATE_POOL_SIZE) as { id: string }[];
  const rankBm25 = new Map<string, number>(bm25Rows.map((r, i) => [r.id, i + 1]));

  const { clause: structClause, params: structParams } = compileArtifactFilters(args.filters);
  const structuredIds = (
    db.prepare(`SELECT artifact_id AS id FROM artifacts ${structClause ? `WHERE ${structClause}` : ""}`).all(...structParams) as { id: string }[]
  ).map((r) => r.id);

  const queryVec = await embedQuery(args.query);
  const rankVec = new Map(
    rankBySimilarity(queryVec, structuredIds)
      .slice(0, CANDIDATE_POOL_SIZE)
      .map((r) => [r.artifactId, r.rank]),
  );

  // Every candidate either side surfaced, before the limit slice. A soft floor on the true match
  // count: each side's window caps at CANDIDATE_POOL_SIZE, so broad topics read as "60+", not an
  // exact corpus-wide total. Still enough signal to distinguish a handful from a pervasive pattern.
  const candidateIds = new Set<string>([...rankBm25.keys(), ...rankVec.keys()]);
  const totalMatches = candidateIds.size;
  const facets = args.facet_by ? facetCandidates(args.facet_by, [...candidateIds]) : undefined;
  const fused = [...candidateIds]
    .map((id) => {
      const rb = rankBm25.get(id);
      const rv = rankVec.get(id);
      const score = (rb !== undefined ? 1 / (RRF_K + rb) : 0) + (rv !== undefined ? 1 / (RRF_K + rv) : 0);
      return { id, score, matchedBm25: rb !== undefined };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (!fused.length) return { rows: [], totalMatches, facets };

  const displayRows = db
    .prepare(
      `SELECT artifact_id, title, artifact_type, created_at, customer_id, product_id, competitor_id, summary ` +
        `FROM artifacts WHERE artifact_id IN (${fused.map(() => "?").join(",")})`,
    )
    .all(...fused.map((f) => f.id)) as Record<string, unknown>[];
  const displayById = new Map(displayRows.map((r) => [r.artifact_id as string, r]));

  const bm25MatchedIds = fused.filter((f) => f.matchedBm25).map((f) => f.id);
  const snippetById = new Map<string, string>();
  if (bm25MatchedIds.length) {
    const matchExpr = compileMatchExpr(args);
    const snipRows = db
      .prepare(
        `SELECT a.artifact_id AS id, snippet(artifacts_fts, 2, '[', ']', '...', 12) AS snippet ` +
          `FROM artifacts_fts f JOIN artifacts a ON a.artifact_id = f.artifact_id ` +
          `WHERE artifacts_fts MATCH ? AND a.artifact_id IN (${bm25MatchedIds.map(() => "?").join(",")})`,
      )
      .all(matchExpr, ...bm25MatchedIds) as { id: string; snippet: string }[];
    for (const r of snipRows) snippetById.set(r.id, r.snippet);
  }

  // Vector-only hits never had an FTS match, so snippet() can't run — fall back to summary.
  const rows = fused.flatMap((f) => {
    const row = displayById.get(f.id);
    if (!row) return [];
    return [{
      artifact_id: row.artifact_id,
      title: row.title,
      artifact_type: row.artifact_type,
      created_at: row.created_at,
      customer_id: row.customer_id,
      product_id: row.product_id,
      competitor_id: row.competitor_id,
      snippet: snippetById.get(f.id) ?? String(row.summary),
    }];
  });
  return { rows, totalMatches, facets };
}

export async function searchArtifacts(args: SearchArtifactsArgs): Promise<QueryResult> {
  const db = getDatabase();
  const limit = Math.max(1, Math.min(args.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX));

  if (args.mode === "count") {
    // Always pure-BM25: cosine similarity has no match/no-match threshold to count against.
    const { clause, params } = compileSearchWhere(args);
    const sql = `SELECT COUNT(*) AS value FROM artifacts_fts f JOIN artifacts a ON a.artifact_id = f.artifact_id ${clause}`;
    const row = db.prepare(sql).get(...params) as Record<string, unknown>;
    return { rows: [row], ids: {} };
  }

  let rows: Record<string, unknown>[];
  let totalMatches: number;
  let facets: Record<string, number> | undefined;
  if (args.semantic === false) {
    const { clause, params } = compileSearchWhere(args);
    const sql = `
      SELECT a.artifact_id, a.title, a.artifact_type, a.created_at, a.customer_id, a.product_id, a.competitor_id,
             snippet(artifacts_fts, 2, '[', ']', '...', 12) AS snippet
      FROM artifacts_fts f JOIN artifacts a ON a.artifact_id = f.artifact_id
      ${clause}
      ORDER BY rank LIMIT ?`;
    rows = db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
    const countSql = `SELECT COUNT(*) AS value FROM artifacts_fts f JOIN artifacts a ON a.artifact_id = f.artifact_id ${clause}`;
    totalMatches = (db.prepare(countSql).get(...params) as { value: number }).value;
    if (args.facet_by) {
      // Exact over the full BM25 match set, not window-capped like the hybrid side.
      const facetSql =
        `SELECT a.${args.facet_by} AS v, COUNT(*) AS n FROM artifacts_fts f JOIN artifacts a ON a.artifact_id = f.artifact_id ` +
        `${clause} AND a.${args.facet_by} IS NOT NULL GROUP BY v ORDER BY n DESC`;
      facets = labelFacets(args.facet_by, db.prepare(facetSql).all(...params) as { v: string; n: number }[]);
    }
  } else {
    ({ rows, totalMatches, facets } = await searchArtifactsHybrid(args, limit));
  }

  const enriched = enrichRows("artifacts", rows);
  return {
    rows: enriched,
    ids: collectIds("artifacts", enriched),
    total_matches: totalMatches,
    truncated: totalMatches > enriched.length,
    ...(facets !== undefined && { facets }),
  };
}
