This repository contains each iterative eval report for each agent architecture. Each eval report is used to inform design decisions.

## eval-report-v0

This report contains the very first eval run on a very simple agent architecture. The agent in this run was given a barebones (and very insecure) `run_sql` tool that allowed for `SELECT` and `WITH` statements. 

```
export const databaseTools = [
  tool(({ sql }) => runSql(sql), {
    name: "run_sql",
    description:
      "Run a read-only SQLite query (SELECT/WITH only) against the Northstar database and return the rows as JSON.",
    schema: z.object({
      sql: z.string().describe("A single read-only SQL statement"),
    }),
  }),
];
```

This is to benchmark our tool coverage before we define more granular tools. E.g: this is testing an agent with maximal sql-writing agency.

The agent does not have access to any semantic meaning or more efficient ranking tools.

As a result, we can see that the agent has relatively low precision with a lot of extraneous context bloat. 

However, since we're fully empowering Claude Opus with free-form sql, the agent does obtain a reasonably high eval pass rate simply via brute force.


Examples of brute force: 

Queries need to rely on word matching and enumerating all possible relevant terms.

**gold_semantic_02**
`run_sql {"sql":"SELECT customer_id, name, account_health, crm_stage, notes FROM customers\nWHERE lower(notes) LIKE '%fix%' OR lower(notes) LIKE '%slow%' OR lower(notes) LIKE '%delay%'\nOR lower(notes) LIKE '%patience%' OR lower(notes) LIKE '%wait%' OR lower(notes) LIKE '%resolution%'\nOR lower(notes) LIKE '%turnaround%' OR lower(notes) LIKE '%too long%' OR lower(notes) LIKE '%frustrat%'\nOR lower(notes) LIKE '%sla%' OR lower(notes) LIKE '%bug%' OR lower(notes) LIKE '%support%'\nOR lower(contacts_json) LIKE '%frustrat%' OR lower(contacts_json) LIKE '%slow%' OR lower(contacts_json) LIKE '%delay%'"}`

On **gold_sample_05**, the agent runs 10 separate sql queries, and obtains a precision of 3% (huge context bloat). This is an intentionally complex query, and we'll need to empower the agent to search more efficiently. Half of these queries were simply to obtain the shape of each table. 

Maximal sql-writing capability can lead to mistakes
On **gold_011**, the agent replied with "35", but the correct answer was "13". The agent made a mistake in its sql query, which led to a more expansive (and inaccurate) search.

The written sql query was: 
```
SELECT COUNT(*) AS cnt FROM artifacts_fts WHERE artifacts_fts MATCH 'runbook automation'
```

The FTS5 parser searched each word "runbook" and "automation" separately, resulting in a more expansive set. The better query would've been `MATCH '"runbook automation"'


## eval-report-v1
This eval report is designed to grade our agent with more granular sql tools.