import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createDbPool, logger } from "@hara/shared";

const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR ?? "/app/migrations";

async function ensureMigrationsTable(db: any) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedMigrations(db: any): Promise<Set<string>> {
  const { rows } = await db.query("SELECT name FROM _migrations");
  return new Set(rows.map((r: any) => r.name));
}

async function run() {
  const db = createDbPool();
  await ensureMigrationsTable(db);
  const applied = await appliedMigrations(db);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    if (applied.has(file)) {
      logger.info({ file }, "skip (already applied)");
      continue;
    }
    const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf8");
    logger.info({ file }, "applying migration");
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO _migrations (name) VALUES ($1)", [file]);
      await client.query("COMMIT");
      logger.info({ file }, "applied");
    } catch (err) {
      await client.query("ROLLBACK");
      logger.error({ file, err }, "migration failed");
      throw err;
    } finally {
      client.release();
    }
  }
  logger.info("migrations complete");
  await db.end();
}

run().catch((err) => {
  logger.error({ err: err.message ?? err }, "migration runner crashed");
  process.exit(1);
});
