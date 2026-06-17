import Database from "better-sqlite3";
import { migrate } from "./migrate.ts";

/** Open (or create) the SQLite DB, set WAL + busy_timeout, run migrations. */
export function openDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}
