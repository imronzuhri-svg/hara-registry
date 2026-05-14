import pg from "pg";
import { logger } from "./logger.js";

const { Pool } = pg;

export type DbPool = pg.Pool;

export function createDbPool(): DbPool {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST ?? "postgres",
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USER ?? "hara",
    password: process.env.POSTGRES_PASSWORD ?? "hara_dev_password",
    database: process.env.POSTGRES_DB ?? "hara_indexer",
    max: Number(process.env.POSTGRES_POOL_MAX ?? 10),
  });

  pool.on("error", (err) => {
    logger.error({ err }, "Postgres pool error");
  });

  return pool;
}
