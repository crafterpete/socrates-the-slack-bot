import Database from "better-sqlite3";
import { env } from "../config/env.js";

let db: Database.Database | undefined;

export function getDatabase(): Database.Database {
  if (!db) {
    db = new Database(env.databasePath, { readonly: true, fileMustExist: true });
    db.pragma("query_only = ON");
  }
  return db;
}
