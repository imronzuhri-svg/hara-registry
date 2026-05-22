/**
 * OpenTelemetry initialisation — side-effect-only module.
 *
 * Each service imports this as the VERY FIRST statement in src/index.ts:
 *
 *   // index.ts
 *   import "@hara/shared/otel";          // ← side effect: starts OTel SDK
 *   import Fastify from "fastify";       // ← now auto-instrumented
 *   import pg from "pg";                 // ← now auto-instrumented
 *   ...
 *
 * Why side-effect import: OTel's auto-instrumentations patch HTTP / pg /
 * redis / fastify at module load time. If we import Fastify before OTel
 * has finished initializing, the patch never lands. ES module evaluation
 * order is source-order within a single file, so putting `import
 * "@hara/shared/otel"` literally first guarantees init runs before any
 * library the service depends on.
 *
 * Activation: this module is a no-op unless OTEL_EXPORTER_OTLP_ENDPOINT
 * is set in the environment. Services start fine without OTel; CI runs
 * unchanged. Set the endpoint (typically http://tempo:4318) in compose
 * to turn it on.
 *
 * Service identity: pulls OTEL_SERVICE_NAME (preferred) or HARA_SERVICE_NAME
 * from env. Falls back to a generic "hara-service" with a loud warning —
 * service names should always be explicit.
 *
 * What gets traced (out of the box, via auto-instrumentations-node):
 *   • HTTP server requests (Fastify routes)
 *   • HTTP client calls (fetch, undici)
 *   • Postgres queries (pg)
 *   • Redis commands (ioredis)
 *   • DNS lookups
 *
 * What's NOT traced automatically:
 *   • Custom spans inside business logic — services that want them
 *     import `getTracer()` (re-exported from "@opentelemetry/api") and
 *     create spans manually.
 *   • Worker-loop iterations — anchor-worker / broadcaster /etc. The
 *     auto-instrumentations only cover the libraries above. A worker
 *     that does an anchor cycle should manually span each cycle if it
 *     wants per-cycle tracing.
 *
 * Graceful shutdown: SIGTERM / SIGINT flush pending spans then exit.
 */

import process from "node:process";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
// @opentelemetry/resources ^2.0.0 made Resource a type-only export;
// resourceFromAttributes() is the canonical constructor now.
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { diag, DiagConsoleLogger, DiagLogLevel } from "@opentelemetry/api";

const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

if (endpoint) {
  // Map our log-level convention to OTel's diag levels. Default to ERROR
  // so a misconfigured exporter doesn't spam the service's normal logs.
  const diagLevel =
    process.env.OTEL_LOG_LEVEL === "debug"
      ? DiagLogLevel.DEBUG
      : process.env.OTEL_LOG_LEVEL === "info"
        ? DiagLogLevel.INFO
        : DiagLogLevel.ERROR;
  diag.setLogger(new DiagConsoleLogger(), diagLevel);

  const serviceName =
    process.env.OTEL_SERVICE_NAME ||
    process.env.HARA_SERVICE_NAME ||
    (() => {
      // eslint-disable-next-line no-console
      console.warn(
        "[otel] OTEL_SERVICE_NAME not set — falling back to 'hara-service'. " +
          "Set it explicitly per service for usable traces.",
      );
      return "hara-service";
    })();

  const serviceVersion = process.env.HARA_SERVICE_VERSION || "0.1.0";

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
      // Helpful tags for filtering in Tempo / Grafana when multiple stacks
      // share a Tempo backend.
      "hara.stack": process.env.HARA_STACK ?? "hara-ledger",
      "hara.env": process.env.HARA_ENV ?? "dev",
    }),
    traceExporter: new OTLPTraceExporter({
      // Standard OTLP/HTTP path is /v1/traces. We append it here so the
      // env var stays short and matches Tempo's default listener URL.
      url: endpoint.endsWith("/v1/traces")
        ? endpoint
        : `${endpoint.replace(/\/+$/, "")}/v1/traces`,
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        // fs instrumentation is too noisy — every file read becomes a span.
        "@opentelemetry/instrumentation-fs": { enabled: false },
        // dns is similarly chatty without much value at this scale.
        "@opentelemetry/instrumentation-dns": { enabled: false },
      }),
    ],
  });

  sdk.start();

  const shutdown = () => {
    sdk
      .shutdown()
      .catch((e) => {
        // eslint-disable-next-line no-console
        console.error("[otel] shutdown failed", e);
      })
      .finally(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}

// Re-export the tracer factory so callers that want custom spans can do:
//   import { trace } from "@hara/shared/otel";
//   const span = trace.getTracer("anchor-worker").startSpan("cycle");
export { trace, context, SpanKind, SpanStatusCode } from "@opentelemetry/api";
