import { getDatabase } from "./client.js";

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

export interface SearchArtifactsArgs {
  query: string;
  exact_phrase?: boolean;
  filters?: {
    customer_id?: string;
    product_id?: string;
    competitor_id?: string;
    artifact_type?: string;
    created_after?: string;
    created_before?: string;
  };
  mode?: QueryMode;
  limit?: number;
}

export interface QueryResult {
  rows: Record<string, unknown>[];
  ids: Record<string, string[]>;
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

// Inverse of each entity's primary key: id column -> owning entity. Derived from ENTITY_SCHEMA
// so it can't drift from the table definitions (consumed by the golden-set builder).
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

function sampleEnumValues(entity: EntityName): Record<string, string[]> {
  const db = getDatabase();
  const schema = ENTITY_SCHEMA[entity];
  const result: Record<string, string[]> = {};
  for (const column of schema.columns) {
    if (column === schema.pk || FK_ENRICHMENT[column]) continue; // pk/FK ids: not enum-shaped, use foreign_keys instead
    const rows = db
      .prepare(`SELECT DISTINCT ${column} AS v FROM ${schema.table} WHERE ${column} IS NOT NULL LIMIT ?`)
      .all(ENUM_VALUE_CAP + 1) as { v: unknown }[];
    if (rows.length > 0 && rows.length <= ENUM_VALUE_CAP) {
      result[column] = rows.map((r) => String(r.v)).sort((a, b) => {
        const na = Number(a);
        const nb = Number(b);
        return !Number.isNaN(na) && !Number.isNaN(nb) ? na - nb : a.localeCompare(b);
      });
    }
  }
  return result;
}

export function describeEntity(entity: EntityName): EntitySchemaInfo {
  const schema = ENTITY_SCHEMA[entity];
  if (!schema) {
    throw new Error(`Unknown entity "${entity}". Valid entities: ${Object.keys(ENTITY_SCHEMA).join(", ")}`);
  }
  const foreign_keys = schema.columns
    .filter((c) => c !== schema.pk && FK_ENRICHMENT[c])
    .map((c) => ({ column: c, references: FK_ENRICHMENT[c]!.entity }));
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
        if (!Array.isArray(f.value) || f.value.length !== 2) {
          throw new Error(`"between" requires an array of exactly 2 values for column "${f.column}"`);
        }
        parts.push(`${col} BETWEEN ? AND ?`);
        params.push(f.value[0], normalizeUpperBound(f.value[1]!));
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
        if (!idsByFk.has(fk)) idsByFk.set(fk, new Set());
        idsByFk.get(fk)!.add(v);
      }
    }
  }
  if (!idsByFk.size) return rows;

  const nameByFk = new Map<string, Map<string, string>>();
  for (const [fk, idSet] of idsByFk) {
    const { entity: targetEntity, nameColumn } = FK_ENRICHMENT[fk]!;
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

export const SEARCH_LIMIT_DEFAULT = 5;
export const SEARCH_LIMIT_MAX = 15;

function compileSearchWhere(args: SearchArtifactsArgs): { clause: string; params: unknown[] } {
  const matchExpr = args.exact_phrase !== false ? `"${args.query.replace(/"/g, '""')}"` : args.query;
  const params: unknown[] = [matchExpr];
  let clause = "WHERE artifacts_fts MATCH ?";

  const filters = args.filters ?? {};
  if (filters.customer_id) {
    clause += ` AND a.customer_id = ?`;
    params.push(filters.customer_id);
  }
  if (filters.product_id) {
    clause += ` AND a.product_id = ?`;
    params.push(filters.product_id);
  }
  if (filters.competitor_id) {
    clause += ` AND a.competitor_id = ?`;
    params.push(filters.competitor_id);
  }
  if (filters.artifact_type) {
    clause += ` AND a.artifact_type = ?`;
    params.push(filters.artifact_type);
  }
  if (filters.created_after) {
    clause += ` AND a.created_at >= ?`;
    params.push(filters.created_after);
  }
  if (filters.created_before) {
    clause += ` AND a.created_at <= ?`;
    params.push(normalizeUpperBound(filters.created_before));
  }
  return { clause, params };
}

export function searchArtifacts(args: SearchArtifactsArgs): QueryResult {
  const db = getDatabase();
  const { clause, params } = compileSearchWhere(args);

  if (args.mode === "count") {
    const sql = `SELECT COUNT(*) AS value FROM artifacts_fts f JOIN artifacts a ON a.artifact_id = f.artifact_id ${clause}`;
    const row = db.prepare(sql).get(...params) as Record<string, unknown>;
    return { rows: [row], ids: {} };
  }

  const sql = `
    SELECT a.artifact_id, a.title, a.artifact_type, a.created_at, a.customer_id, a.product_id, a.competitor_id,
           snippet(artifacts_fts, 2, '[', ']', '...', 12) AS snippet
    FROM artifacts_fts f JOIN artifacts a ON a.artifact_id = f.artifact_id
    ${clause}
    ORDER BY rank LIMIT ?`;
  const limit = Math.max(1, Math.min(args.limit ?? SEARCH_LIMIT_DEFAULT, SEARCH_LIMIT_MAX));

  const rows = db.prepare(sql).all(...params, limit) as Record<string, unknown>[];
  const enriched = enrichRows("artifacts", rows);
  return { rows: enriched, ids: collectIds("artifacts", enriched) };
}
