/**
 * Gapura Gateway bootstrap. REAL.
 *
 * Registers the RFC 9457 error handler, builds the store + services, wires the
 * routes (each with its own auth preHandler + scope), and listens on GATEWAY_PORT.
 */

import Fastify from "fastify";
import { config } from "./config.js";
import { registerErrorHandler } from "./errors.js";
import { createStore } from "./store/index.js";
import { AnchorService } from "./services/anchor-service.js";
import { HaraDidClient } from "./clients/haradid.js";
import { registerAnchorRoutes } from "./routes/anchors.js";
import { registerIdentityRoutes } from "./routes/identity.js";
import { registerMeteringRoutes } from "./routes/metering.js";
import { registerHealthRoutes } from "./routes/health.js";

async function main(): Promise<void> {
  const app = Fastify({
    logger: { name: "gapura-gateway" },
    genReqId: () => crypto.randomUUID(),
  });

  registerErrorHandler(app);

  const store = await createStore();
  const anchors = new AnchorService(store);
  const haradid = new HaraDidClient();

  registerHealthRoutes(app, { anchors });
  registerAnchorRoutes(app, { anchors, store });
  registerIdentityRoutes(app, { store, haradid });
  registerMeteringRoutes(app);

  const authMode = config.authentik.jwksUrl ? "authentik-jwt" : "DEV-BYPASS";
  const storeMode = config.pgUrl ? "postgres" : "in-memory";
  app.log.info(
    { port: config.port, authMode, storeMode, writesEnabled: anchors.writesEnabled },
    "gapura-gateway starting",
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
  console.error("gapura-gateway failed to start:", e);
  process.exit(1);
});
