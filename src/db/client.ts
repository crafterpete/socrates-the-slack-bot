import Database from "better-sqlite3";
import { env } from "../config/env.js";

let db: Database.Database | undefined;

function getDatabase(): Database.Database {
  if (!db) {
    db = new Database(env.databasePath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
  }
  return db;
}

export function runSql(sql: string): string {
  if (!/^\s*(select|with)\b/i.test(sql)) {
    throw new Error("Only read-only SELECT/WITH queries are allowed.");
  }
  const rows = getDatabase().prepare(sql).all();
  return JSON.stringify(rows);
}
