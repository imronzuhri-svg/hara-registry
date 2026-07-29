/**
 * Identity routes (§4). Resolve/register proxy to HaraDID/Numira; bindings via
 * the store. REAL wiring where a resolver URL is configured; STUB DID docs in
 * dev (see clients/haradid.ts).
 *   GET  /v1/did/:did                          scope identity:read
 *   POST /v1/identities                        scope identity:write
 *   GET  /v1/identities/operations/:id         scope identity:read
 *   GET  /v1/identities/by-subject/:sub        scope identity:read
 *   POST /v1/identities/:did/bindings          scope identity:write
 */

import type { FastifyInstance } from "fastify";
import { requireScope } from "../auth.js";
import { ProblemError, sendProblem } from "../errors.js";
import { DidClientError, HaraDidClient } from "../clients/haradid.js";
import type { Store } from "../store/index.js";
import type { IdentityRequest, Operation } from "../types.js";

const DID_RE = /^did:hara:/;

export function registerIdentityRoutes(
  app: FastifyInstance,
  deps: { store: Store; haradid: HaraDidClient },
): void {
  const { store, haradid } = deps;

  // ── GET /v1/did/:did ────────────────────────────────────────────────────────
  app.get("/v1/did/:did", { preHandler: requireScope("identity:read") }, async (req, reply) => {
    const { did } = req.params as { did: string };
    if (!DID_RE.test(did)) {
      return sendProblem(reply, "invalid_did", "not a did:hara identifier");
    }
    try {
      return reply.send(await haradid.resolve(did));
    } catch (e) {
      if (e instanceof DidClientError) {
        if (e.reason === "did_not_found") return sendProblem(reply, "did_not_found", did);
        if (e.reason === "did_deactivated") return sendProblem(reply, "did_deactivated", did);
        return sendProblem(reply, "invalid_did", e.message);
      }
      throw e;
    }
  });

  // ── POST /v1/identities ─────────────────────────────────────────────────────
  app.post("/v1/identities", { preHandler: requireScope("identity:write") }, async (req, reply) => {
    const body = req.body as IdentityRequest;
    if (!body || typeof body.displayName !== "string" || !body.subjectType) {
      return sendProblem(reply, "invalid_request", "subjectType and displayName are required");
    }
    const result = await haradid.register(body);
    // Sidetree-batched actor DIDs come back as an Operation (202); others 201.
    const isBatching = (result as Operation).state === "batching";
    return reply.code(isBatching ? 202 : 201).send(result);
  });

  // ── GET /v1/identities/operations/:operationId ──────────────────────────────
  app.get(
    "/v1/identities/operations/:operationId",
    { preHandler: requireScope("identity:read") },
    async (req, reply) => {
      const { operationId } = req.params as { operationId: string };
      return reply.send(await haradid.getOperation(operationId));
    },
  );

  // ── GET /v1/identities/by-subject/:authentikSub ─────────────────────────────
  app.get(
    "/v1/identities/by-subject/:authentikSub",
    { preHandler: requireScope("identity:read") },
    async (req, reply) => {
      const { authentikSub } = req.params as { authentikSub: string };
      const binding = await store.getBindingBySubject(authentikSub);
      if (!binding) throw new ProblemError("did_not_found", `no binding for subject ${authentikSub}`);
      return reply.send(binding);
    },
  );

  // ── POST /v1/identities/:did/bindings ───────────────────────────────────────
  app.post(
    "/v1/identities/:did/bindings",
    { preHandler: requireScope("identity:write") },
    async (req, reply) => {
      const { did } = req.params as { did: string };
      if (!DID_RE.test(did)) {
        return sendProblem(reply, "invalid_did", "not a did:hara identifier");
      }
      const body = (req.body ?? {}) as { authentikSub?: string; tenant?: string };
      if (!body.authentikSub || !body.tenant) {
        return sendProblem(reply, "invalid_request", "authentikSub and tenant are required");
      }
      const binding = await store.putBinding({
        authentikSub: body.authentikSub,
        did,
        tenant: body.tenant,
      });
      return reply.code(201).send(binding);
    },
  );
}
