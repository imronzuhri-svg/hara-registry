// Postgres connection + schema bootstrap for the console's user-management.
// Lives in its own `console` schema (separate from the indexer's tables) in the
// production Postgres on hara-stateful. When CONSOLE_DATABASE_URL is unset the
// pool is null and the API runs in legacy open mode (no app auth).
import pg from "pg";
import { config } from "./config.js";

export const pool: pg.Pool | null = config.databaseUrl
  ? new pg.Pool({ connectionString: config.databaseUrl, max: 5, idleTimeoutMillis: 30_000 })
  : null;

export function dbEnabled(): boolean {
  return pool !== null;
}

/** Idempotent schema creation — runs once at boot when auth is enabled. */
export async function ensureSchema(): Promise<void> {
  if (!pool) throw new Error("CONSOLE_DATABASE_URL not set");
  await pool.query(`CREATE SCHEMA IF NOT EXISTS console`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS console.users (
      id            BIGSERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      email         TEXT,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer',
      status        TEXT NOT NULL DEFAULT 'active',
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at TIMESTAMPTZ,
      created_by    TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS console.sessions (
      token_hash TEXT PRIMARY KEY,
      user_id    BIGINT NOT NULL REFERENCES console.users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      user_agent TEXT
    )`);
  await pool.query(`CREATE INDEX IF NOT EXISTS console_sessions_expires_idx ON console.sessions(expires_at)`);
}

/** Drop expired sessions — cheap housekeeping, called opportunistically. */
export async function pruneSessions(): Promise<void> {
  if (!pool) return;
  await pool.query(`DELETE FROM console.sessions WHERE expires_at < now()`).catch(() => {});
}
