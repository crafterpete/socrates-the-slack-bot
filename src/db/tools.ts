import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { runSql } from "./client.js";

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
