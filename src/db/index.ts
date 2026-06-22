import { DatabaseSync } from "node:sqlite";
import { migrate } from "./migrate.ts";

/** Open (or create) the SQLite DB, set WAL + busy_timeout, run migrations. */
export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  return db;
}
