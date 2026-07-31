/**
 * Registry Ledger bootstrap. REAL.
 *
 * Registers the RFC 9457 error handler, builds the store + anchor + ledger core,
 * wires the routes (writes behind the Numira tenant preHandler; proofs/status
 * public), and listens on GATEWAY_PORT (default 8940).
 */

import Fastify from "fastify";
import { config } from "./config.js";
import { registerErrorHandler } from "./errors.js";
import { createStore } from "./store/index.js";
import { AnchorService } from "./services/anchor.js";
import { LedgerService } from "./services/ledger.js";
import { registerAttestationRoutes } from "./routes/attestations.js";
import { registerCheckpointRoutes } from "./routes/checkpoints.js";
import { registerEvidenceRoutes } from "./routes/evidence.js";
import { registerVerifyRoutes } from "./routes/verify.js";
import { registerHealthRoutes } from "./routes/health.js";

async function main(): Promise<void> {
  const app = Fastify({
    logger: { name: "registry-ledger" },
    genReqId: () => crypto.randomUUID(),
  });

  registerErrorHandler(app);

  const store = await createStore();
  const anchors = new AnchorService();
  const ledger = new LedgerService(store, anchors);

  registerHealthRoutes(app, { anchors });
  registerAttestationRoutes(app, { ledger });
  registerCheckpointRoutes(app, { ledger });
  registerEvidenceRoutes(app, { ledger });
  registerVerifyRoutes(app, { ledger });

  const authMode = config.numira.jwksUrl ? "numira-jwt" : "DEV-BYPASS";
  const storeMode = config.pgUrl ? "postgres" : "in-memory";
  app.log.info(
    { port: config.port, authMode, storeMode, writesEnabled: anchors.writesEnabled },
    "registry-ledger starting",
  );

  const closeStore = async () => {
    await store.close().catch(() => {});
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, async () => {
      await app.close();
      await closeStore();
      process.exit(0);
    });
  }

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((e: unknown) => {
  // eslint-disable-next-line no-console
  console.error("registry-ledger failed to start:", e);
  process.exit(1);
});
