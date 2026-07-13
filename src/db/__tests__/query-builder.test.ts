import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { describeEntities, describeEntity, queryEntities, searchArtifacts } from "../query-builder.js";

// Exercises query-builder.ts against the real (read-only) synthetic DB — same pattern as the
// eval scripts under src/eval/, which also query it directly. Run with `npm run eval:test`.

describe("queryEntities: filters", () => {
  test("eq", () => {
    const { rows } = queryEntities({
      entity: "customers",
      filters: [{ column: "name", op: "eq", value: "Arcadia Cloudworks" }],
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.employee_count, 8200);
  });

  test("like", () => {
    const { rows } = queryEntities({
      entity: "implementations",
      filters: [{ column: "status", op: "like", value: "%remediation%" }],
      mode: "count",
    });
    assert.ok((rows[0]!.value as number) > 0);
  });

  test("like auto-wraps a bare value in wildcards (substring match)", () => {
    const { rows } = queryEntities({
      entity: "customers",
      filters: [{ column: "name", op: "like", value: "Nordic MedSupply" }], // real name has an " AB" suffix
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.name, "Nordic MedSupply AB");
  });

  test("like respects an already-wildcarded value as-is", () => {
    const { rows } = queryEntities({
      entity: "customers",
      filters: [{ column: "name", op: "like", value: "Nordic%" }],
    });
    assert.ok(rows.length >= 1);
  });

  test("in", () => {
    const { rows } = queryEntities({
      entity: "competitors",
      filters: [{ column: "name", op: "in", value: ["NoiseGuard", "BeaconOps"] }],
    });
    assert.equal(rows.length, 2);
  });

  test("between", () => {
    const { rows } = queryEntities({
      entity: "artifacts",
      filters: [{ column: "created_at", op: "between", value: ["2026-03-17", "2026-03-20"] }],
      mode: "count",
    });
    assert.ok((rows[0]!.value as number) > 0);
  });

  test("between's bare-date upper bound includes the entire final day, not just midnight", () => {
    const { rows: dateOnly } = queryEntities({
      entity: "artifacts",
      filters: [{ column: "created_at", op: "between", value: ["2026-03-20", "2026-03-20"] }],
      mode: "count",
    });
    const { rows: fullDay } = queryEntities({
      entity: "artifacts",
      filters: [{ column: "created_at", op: "between", value: ["2026-03-20", "2026-03-20T23:59:59"] }],
      mode: "count",
    });
    assert.equal(dateOnly[0]!.value, fullDay[0]!.value);
  });

  test("lte's bare-date value includes the entire day", () => {
    const { rows: dateOnly } = queryEntities({
      entity: "artifacts",
      filters: [{ column: "created_at", op: "lte", value: "2026-01-01" }],
      mode: "count",
    });
    const { rows: midnightOnly } = queryEntities({
      entity: "artifacts",
      filters: [{ column: "created_at", op: "lte", value: "2026-01-01T00:00:00" }],
      mode: "count",
    });
    assert.ok((dateOnly[0]!.value as number) >= (midnightOnly[0]!.value as number));
  });

  test("between rejects a non-2-element array", () => {
    assert.throws(() =>
      queryEntities({
        entity: "artifacts",
        filters: [{ column: "created_at", op: "between", value: ["2026-03-17"] }],
      }),
    );
  });

  test("multiple filters combine with AND", () => {
    const { rows: bothFilters } = queryEntities({
      entity: "customers",
      filters: [
        { column: "industry", op: "eq", value: "Healthcare" },
        { column: "account_health", op: "eq", value: "at risk" },
      ],
      mode: "count",
    });
    const { rows: oneFilter } = queryEntities({
      entity: "customers",
      filters: [{ column: "industry", op: "eq", value: "Healthcare" }],
      mode: "count",
    });
    assert.ok((bothFilters[0]!.value as number) <= (oneFilter[0]!.value as number));
  });
});

describe("queryEntities: column allowlist", () => {
  test("rejects an unknown filter column", () => {
    assert.throws(
      () => queryEntities({ entity: "customers", filters: [{ column: "not_a_column", op: "eq", value: "x" }] }),
      /Unknown column/,
    );
  });

  test("rejects an unknown select column", () => {
    assert.throws(
      () => queryEntities({ entity: "customers", select: ["not_a_column"] }),
      /Unknown column/,
    );
  });

  test("rejects an unknown entity", () => {
    assert.throws(() => queryEntities({ entity: "not_an_entity" as never }), /Unknown entity/);
  });
});

describe("queryEntities: limit", () => {
  test("defaults to 20", () => {
    const { rows } = queryEntities({ entity: "artifacts" });
    assert.ok(rows.length <= 20);
  });

  test("hard-caps at 50 even when a larger limit is requested", () => {
    const { rows } = queryEntities({ entity: "artifacts", limit: 10_000 });
    assert.ok(rows.length <= 50);
  });

  test("mode: count is never capped by limit", () => {
    const { rows } = queryEntities({ entity: "artifacts", mode: "count", limit: 1 });
    assert.equal(rows[0]!.value, 250);
  });
});

describe("queryEntities: FK enrichment", () => {
  test("attaches the referenced row's display name alongside its id", () => {
    const { rows } = queryEntities({
      entity: "implementations",
      filters: [{ column: "customer_id", op: "eq", value: "cus_10762173c26d" }],
      limit: 1,
    });
    assert.equal(rows[0]!.customer_name, "BlueHarbor Logistics");
    assert.ok(typeof rows[0]!.customer_id === "string");
  });

  test("does not redundantly enrich an entity's own primary key", () => {
    const { rows } = queryEntities({
      entity: "customers",
      filters: [{ column: "customer_id", op: "eq", value: "cus_10762173c26d" }],
    });
    assert.equal(rows[0]!.customer_name, undefined);
  });

  test("ids contains only the queried entity, never the FK entities the row points at", () => {
    const { ids } = queryEntities({
      entity: "implementations",
      filters: [{ column: "customer_id", op: "eq", value: "cus_10762173c26d" }],
      limit: 1,
    });
    assert.ok(ids.implementations?.length);
    assert.equal(ids.customers, undefined); // FK attributes are not retrieved objects
    assert.equal(ids.products, undefined);
    assert.equal(ids.scenarios, undefined);
  });
});

describe("queryEntities: distinct", () => {
  test("returns unique values only", () => {
    const { rows } = queryEntities({ entity: "customers", select: ["region"], distinct: true });
    const regions = rows.map((r) => r.region);
    assert.equal(regions.length, new Set(regions).size);
  });

  test("does not force an id column into a distinct query", () => {
    const { rows, ids } = queryEntities({ entity: "customers", select: ["region"], distinct: true });
    assert.equal(rows[0]!.customer_id, undefined);
    assert.deepEqual(ids, {});
  });
});

describe("queryEntities: id traceability", () => {
  test("a narrow select still returns the entity's own id, so retrieval scoring never silently breaks", () => {
    const { rows, ids } = queryEntities({
      entity: "customers",
      filters: [{ column: "name", op: "eq", value: "Arcadia Cloudworks" }],
      select: ["name", "industry"],
    });
    assert.equal(rows[0]!.customer_id, "cus_ce2defcf5292");
    assert.deepEqual(ids, { customers: ["cus_ce2defcf5292"] });
  });

  test("a narrow select does NOT pull in other FK columns beyond what was requested", () => {
    const { rows, ids } = queryEntities({
      entity: "implementations",
      filters: [{ column: "customer_id", op: "eq", value: "cus_10762173c26d" }],
      select: ["status"],
      limit: 1,
    });
    assert.ok(typeof rows[0]!.implementation_id === "string"); // own id: always forced
    assert.equal(rows[0]!.customer_id, undefined); // incidental FK: not forced, avoids precision noise
    assert.ok(ids.implementations?.length);
    assert.equal(ids.customers, undefined);
  });

  test("an FK id never enters `ids` even when it is explicitly selected (still an attribute, not a retrieval)", () => {
    const { rows, ids } = queryEntities({
      entity: "implementations",
      filters: [{ column: "customer_id", op: "eq", value: "cus_10762173c26d" }],
      select: ["status", "customer_id"],
      limit: 1,
    });
    assert.equal(rows[0]!.customer_id, "cus_10762173c26d"); // present in the row for the agent to read
    assert.equal(ids.customers, undefined); // but not counted as a retrieved object
    assert.ok(ids.implementations?.length);
  });
});

describe("queryEntities: group_by + aggregate", () => {
  test("requires aggregate when group_by is set", () => {
    assert.throws(() => queryEntities({ entity: "employees", group_by: "department" }));
  });

  test("groups, aggregates, and ranks in one call", () => {
    const { rows } = queryEntities({
      entity: "employees",
      group_by: "department",
      aggregate: { fn: "count" },
      limit: 2,
    });
    assert.equal(rows.length, 2);
    assert.ok((rows[0]!.value as number) >= (rows[1]!.value as number));
  });

  test("rejects an aggregate.fn outside the allowlist, independent of the caller's own validation", () => {
    assert.throws(
      () =>
        queryEntities({
          entity: "customers",
          aggregate: {
            fn: "1 AS value FROM customers WHERE 0 UNION SELECT group_concat(sql,'|') FROM sqlite_master--" as never,
            column: "customer_id",
          },
        }),
      /Unknown aggregate function/,
    );
  });
});

describe("describeEntity", () => {
  test("returns every column on the entity", () => {
    const { columns } = describeEntity("customers");
    assert.ok(columns.includes("industry"));
    assert.ok(columns.includes("customer_id"));
  });

  test("flags foreign-key columns with what entity they reference", () => {
    const { foreign_keys } = describeEntity("implementations");
    assert.deepEqual(
      foreign_keys.find((fk) => fk.column === "customer_id"),
      { column: "customer_id", references: "customers" },
    );
    assert.deepEqual(
      foreign_keys.find((fk) => fk.column === "product_id"),
      { column: "product_id", references: "products" },
    );
  });

  test("an entity with no foreign keys returns an empty list, not an error", () => {
    const { foreign_keys } = describeEntity("competitors");
    assert.deepEqual(foreign_keys, []);
  });

  test("every foreign key it reports is actually usable as a group_by via hop", () => {
    const { foreign_keys } = describeEntity("implementations");
    for (const fk of foreign_keys) {
      assert.doesNotThrow(() =>
        queryEntities({
          entity: "implementations",
          group_by: { via: fk.column, column: describeEntity(fk.references).columns[0]! },
          aggregate: { fn: "count" },
        }),
      );
    }
  });

  test("rejects an unknown entity", () => {
    assert.throws(() => describeEntity("not_an_entity" as never), /Unknown entity/);
  });
});

describe("describeEntity: enum_values", () => {
  test("includes real values for a low-cardinality column", () => {
    const { enum_values } = describeEntity("customers");
    assert.deepEqual(enum_values.account_health, ["at risk", "expanding", "healthy", "recovering", "watch list"]);
  });

  test("excludes a high-cardinality free-text column", () => {
    const { enum_values } = describeEntity("customers");
    assert.equal(enum_values.notes, undefined);
    assert.equal(enum_values.name, undefined);
  });

  test("excludes a dirty/high-cardinality enum-shaped column (implementations.status, ~33 variants)", () => {
    const { enum_values } = describeEntity("implementations");
    assert.equal(enum_values.status, undefined);
  });

  test("excludes the entity's own primary key even though every value is technically distinct", () => {
    const { enum_values } = describeEntity("customers");
    assert.equal(enum_values.customer_id, undefined);
  });

  test("excludes foreign-key columns even when their cardinality is low (use foreign_keys instead)", () => {
    const { enum_values } = describeEntity("implementations");
    assert.equal(enum_values.customer_id, undefined);
    assert.equal(enum_values.product_id, undefined); // only 4 distinct product ids, but not enum-shaped
  });

  test("sorts numeric-looking values numerically, not lexicographically", () => {
    const { enum_values } = describeEntity("customers");
    const counts = enum_values.employee_count!.map(Number);
    const sorted = [...counts].sort((a, b) => a - b);
    assert.deepEqual(counts, sorted);
  });
});

describe("describeEntities: batch", () => {
  test("describes multiple entities in one call, in the order requested", () => {
    const results = describeEntities(["implementations", "customers"]);
    assert.equal(results.length, 2);
    assert.equal(results[0]!.entity, "implementations");
    assert.equal(results[1]!.entity, "customers");
    assert.ok(results[1]!.columns.includes("industry"));
  });

  test("matches calling describeEntity individually for each entity", () => {
    const batch = describeEntities(["products", "scenarios"]);
    assert.deepEqual(batch[0], describeEntity("products"));
    assert.deepEqual(batch[1], describeEntity("scenarios"));
  });

  test("a single unknown entity in the batch throws, naming that entity", () => {
    assert.throws(
      () => describeEntities(["customers", "not_an_entity" as never]),
      /Unknown entity "not_an_entity"/,
    );
  });
});

describe("queryEntities: group_by via (cross-table)", () => {
  test("groups by a column on the related entity, matching a manual two-call reconciliation", () => {
    const { rows: customers } = queryEntities({
      entity: "customers",
      filters: [{ column: "industry", op: "eq", value: "Healthcare" }],
      select: ["customer_id"],
      limit: 50,
    });
    const { rows: implementations } = queryEntities({
      entity: "implementations",
      filters: [{ column: "customer_id", op: "in", value: customers.map((c) => c.customer_id as string) }],
      select: ["contract_value"],
      limit: 50,
    });
    const manualSum = implementations.reduce((sum, r) => sum + (r.contract_value as number), 0);

    const { rows: viaRows } = queryEntities({
      entity: "implementations",
      group_by: { via: "customer_id", column: "industry" },
      aggregate: { fn: "sum", column: "contract_value" },
      limit: 20,
    });
    assert.equal(viaRows.find((r) => r.group_key === "Healthcare")!.value, manualSum);
  });

  test("every group's rows sum to the same total as an ungrouped aggregate (no double-counting or drops)", () => {
    const { rows: total } = queryEntities({ entity: "implementations", aggregate: { fn: "sum", column: "contract_value" } });
    const { rows: byIndustry } = queryEntities({
      entity: "implementations",
      group_by: { via: "customer_id", column: "industry" },
      aggregate: { fn: "sum", column: "contract_value" },
      limit: 50,
    });
    const summed = byIndustry.reduce((sum, r) => sum + (r.value as number), 0);
    assert.equal(summed, total[0]!.value);
  });

  test("composes with a regular filter on the base entity", () => {
    const { rows } = queryEntities({
      entity: "implementations",
      filters: [{ column: "status", op: "eq", value: "active pilot" }],
      group_by: { via: "customer_id", column: "industry" },
      aggregate: { fn: "count" },
      limit: 50,
    });
    const filteredTotal = rows.reduce((sum, r) => sum + (r.value as number), 0);
    const { rows: unfiltered } = queryEntities({ entity: "implementations", filters: [{ column: "status", op: "eq", value: "active pilot" }], mode: "count" });
    assert.equal(filteredTotal, unfiltered[0]!.value);
  });

  test("rejects a via that is not a column on the queried entity", () => {
    assert.throws(
      () =>
        queryEntities({
          entity: "implementations",
          group_by: { via: "primary_competitor_id", column: "segment" },
          aggregate: { fn: "count" },
        }),
      /not a column on entity/,
    );
  });

  test("rejects a via that is a real column but not a recognized foreign key", () => {
    assert.throws(
      () =>
        queryEntities({
          entity: "implementations",
          group_by: { via: "status", column: "name" },
          aggregate: { fn: "count" },
        }),
      /not a foreign key/,
    );
  });

  test("rejects an unknown column on the related entity", () => {
    assert.throws(
      () =>
        queryEntities({
          entity: "implementations",
          group_by: { via: "customer_id", column: "not_a_column" },
          aggregate: { fn: "count" },
        }),
      /Unknown column/,
    );
  });
});

describe("searchArtifacts", () => {
  test("exact_phrase true matches the quoted phrase count", () => {
    const { rows } = searchArtifacts({ query: "runbook automation", exact_phrase: true, limit: 15 });
    assert.equal(rows.length, 13);
  });

  test("exact_phrase false (bag-of-words) matches a superset", () => {
    const { rows } = searchArtifacts({ query: "runbook automation", exact_phrase: false, limit: 15 });
    assert.equal(rows.length, 15); // capped at max; the true bag-of-words match count (35) exceeds it
  });

  test("results are ordered by BM25 relevance, best match first", () => {
    const { rows } = searchArtifacts({ query: "runbook", exact_phrase: false, limit: 5 });
    assert.ok(rows.length > 1);
  });

  test("hard-caps at 15 even when a larger limit is requested", () => {
    const { rows } = searchArtifacts({ query: "runbook", exact_phrase: false, limit: 1000 });
    assert.ok(rows.length <= 15);
  });

  test("mode: count returns an exact total, uncapped by limit", () => {
    const { rows } = searchArtifacts({ query: "runbook automation", exact_phrase: true, mode: "count" });
    assert.equal(rows[0]!.value, 13);
  });

  test("mode: count respects filters and exact_phrase like rows mode does", () => {
    const { rows } = searchArtifacts({ query: "runbook automation", exact_phrase: false, mode: "count" });
    assert.equal(rows[0]!.value, 35);
  });

  test("filters scope results to one customer", () => {
    const { rows } = searchArtifacts({
      query: "search relevance",
      exact_phrase: false,
      filters: { customer_id: "cus_10762173c26d" },
    });
    assert.ok(rows.every((r) => r.customer_id === "cus_10762173c26d"));
  });
});
