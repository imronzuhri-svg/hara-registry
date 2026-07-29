/**
 * RFC 9457 `application/problem+json` helpers + a Fastify error serializer.
 *
 * REAL. Codes and HTTP statuses follow §7 of the integration guide.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Problem } from "./types.js";

const ERROR_BASE = "https://gapura.ledger.haratrust.io/errors/";

/** Stable machine codes from §7 of the integration guide. */
export type ProblemCode =
  | "invalid_digest"
  | "invalid_did"
  | "invalid_period"
  | "invalid_request"
  | "unauthenticated"
  | "forbidden_scope"
  | "did_not_found"
  | "anchor_not_found"
  | "idempotency_conflict"
  | "did_deactivated"
  | "unanchorable"
  | "rate_limited"
  | "anchor_failed"
  | "chain_unavailable"
  | "internal_error";

const CODE_META: Record<ProblemCode, { status: number; title: string }> = {
  invalid_digest: { status: 400, title: "Invalid digest" },
  invalid_did: { status: 400, title: "Invalid DID" },
  invalid_period: { status: 400, title: "Invalid period" },
  invalid_request: { status: 400, title: "Invalid request" },
  unauthenticated: { status: 401, title: "Unauthenticated" },
  forbidden_scope: { status: 403, title: "Forbidden scope" },
  did_not_found: { status: 404, title: "DID not found" },
  anchor_not_found: { status: 404, title: "Anchor not found" },
  idempotency_conflict: { status: 409, title: "Idempotency conflict" },
  did_deactivated: { status: 410, title: "DID deactivated" },
  unanchorable: { status: 422, title: "Unanchorable" },
  rate_limited: { status: 429, title: "Rate limited" },
  anchor_failed: { status: 502, title: "Anchor failed" },
  chain_unavailable: { status: 503, title: "Chain unavailable" },
  internal_error: { status: 500, title: "Internal error" },
};

/**
 * A throwable problem. Route handlers throw this; the Fastify error handler
 * (registerErrorHandler) serializes it to problem+json.
 */
export class ProblemError extends Error {
  readonly code: ProblemCode;
  readonly status: number;
  readonly detail?: string;

  constructor(code: ProblemCode, detail?: string) {
    super(detail ?? CODE_META[code].title);
    this.name = "ProblemError";
    this.code = code;
    this.status = CODE_META[code].status;
    this.detail = detail;
    Object.setPrototypeOf(this, ProblemError.prototype);
  }
}

function buildProblem(
  code: ProblemCode,
  detail: string | undefined,
  instance: string | undefined,
  traceId: string | undefined,
): Problem {
  const meta = CODE_META[code];
  return {
    type: ERROR_BASE + code,
    title: meta.title,
    status: meta.status,
    code,
    detail,
    instance,
    traceId,
  };
}

/** Send an RFC 9457 problem response. */
export function sendProblem(
  reply: FastifyReply,
  code: ProblemCode,
  detail?: string,
): FastifyReply {
  const req = reply.request;
  const body = buildProblem(code, detail, req.url, req.id as string);
  return reply
    .code(CODE_META[code].status)
    .header("content-type", "application/problem+json")
    .send(body);
}

/**
 * Register the global error handler + 404 handler so every error path emits
 * problem+json (not Fastify's default JSON envelope).
 */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((err, req: FastifyRequest, reply: FastifyReply) => {
    if (err instanceof ProblemError) {
      return reply
        .code(err.status)
        .header("content-type", "application/problem+json")
        .send(buildProblem(err.code, err.detail, req.url, req.id as string));
    }

    // Fastify validation errors → 400 invalid_request.
    if ((err as { validation?: unknown }).validation) {
      return reply
        .code(400)
        .header("content-type", "application/problem+json")
        .send(buildProblem("invalid_request", err.message, req.url, req.id as string));
    }

    req.log.error({ err }, "unhandled error");
    return reply
      .code(500)
      .header("content-type", "application/problem+json")
      .send(buildProblem("internal_error", "unexpected error", req.url, req.id as string));
  });

  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    return reply
      .code(404)
      .header("content-type", "application/problem+json")
      .send(buildProblem("anchor_not_found", `no route ${req.method} ${req.url}`, req.url, req.id as string));
  });
}
