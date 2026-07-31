/**
 * Attestation routes (§3). REAL — wired to LedgerService.
 *   POST /v1/attestations                     (Numira) append leaf → inclusion proof → STH+anchor
 *   GET  /v1/attestations/:registryId         (public)  resolve metadata
 *   GET  /v1/attestations/:registryId/proof    (public)  inclusion proof (?tree_size=)
 *   GET  /v1/attestations/:registryId/status   (public)  status of record
 *   POST /v1/attestations/:registryId/revoke   (Numira) revoke/supersede (tenant-scoped)
 */

import type { FastifyInstance } from "fastify";
import { enforceTenant, requireTenant } from "../auth.js";
import { sendProblem } from "../errors.js";
import type { LedgerService } from "../services/ledger.js";
import type { AttestationRequest, RecordType, RevokeRequest } from "../types.js";

const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const DID_RE = /^did:hara:/;
const RECORD_TYPES: RecordType[] = ["surveyor-report", "assay", "gate-decision", "custody-event", "other"];

export function registerAttestationRoutes(
  app: FastifyInstance,
  deps: { ledger: LedgerService },
): void {
  const { ledger } = deps;

  // ── POST /v1/attestations ────────────────────────────────────────────────────
  app.post("/v1/attestations", { preHandler: requireTenant }, async (req, reply) => {
    const body = req.body as AttestationRequest;
    if (!body || typeof body.contentHash !== "string" || !HASH_RE.test(body.contentHash)) {
      return sendProblem(reply, "invalid_hash", "contentHash must be 32-byte 0x-prefixed hex");
    }
    if (typeof body.subject !== "string" || !DID_RE.test(body.subject)) {
      return sendProblem(reply, "invalid_did", "subject must be a did:hara identifier");
    }
    if (typeof body.issuer !== "string" || !DID_RE.test(body.issuer)) {
      return sendProblem(reply, "invalid_did", "issuer must be a did:hara identifier");
    }
    if (typeof body.recordType !== "string" || !RECORD_TYPES.includes(body.recordType as RecordType)) {
      return sendProblem(reply, "invalid_request", `recordType must be one of ${RECORD_TYPES.join(", ")}`);
    }
    if (body.hashAlg !== undefined && body.hashAlg !== "sha256") {
      return sendProblem(reply, "invalid_request", "hashAlg must be sha256");
    }

    // Tenant-scoping: the issuer DID must match the token's tenant DID.
    enforceTenant(req, body.issuer);

    const { attestation, alreadyAnchored } = await ledger.anchorAttestation(body, req.tenantDid);
    return reply.code(alreadyAnchored ? 200 : 201).send(attestation);
  });

  // ── GET /v1/attestations/:registryId (public) ─────────────────────────────────
  app.get("/v1/attestations/:registryId", async (req, reply) => {
    const { registryId } = req.params as { registryId: string };
    return reply.send(await ledger.getAttestation(registryId));
  });

  // ── GET /v1/attestations/:registryId/proof (public) ───────────────────────────
  app.get("/v1/attestations/:registryId/proof", async (req, reply) => {
    const { registryId } = req.params as { registryId: string };
    const { tree_size } = req.query as { tree_size?: string };
    let size: number | undefined;
    if (tree_size !== undefined) {
      size = Number(tree_size);
      if (!Number.isInteger(size) || size < 1) {
        return sendProblem(reply, "invalid_request", "tree_size must be a positive integer");
      }
    }
    return reply.send(await ledger.getInclusion(registryId, size));
  });

  // ── GET /v1/attestations/:registryId/status (public) ──────────────────────────
  app.get("/v1/attestations/:registryId/status", async (req, reply) => {
    const { registryId } = req.params as { registryId: string };
    return reply.send(await ledger.getStatusRecord(registryId));
  });

  // ── POST /v1/attestations/:registryId/revoke (tenant-scoped) ──────────────────
  app.post("/v1/attestations/:registryId/revoke", { preHandler: requireTenant }, async (req, reply) => {
    const { registryId } = req.params as { registryId: string };
    const body = (req.body ?? {}) as RevokeRequest;
    if (body.action !== "revoke" && body.action !== "supersede") {
      return sendProblem(reply, "invalid_request", "action must be revoke or supersede");
    }
    if (typeof body.reason !== "string" || body.reason.length === 0) {
      return sendProblem(reply, "invalid_request", "reason is required");
    }
    if (body.action === "supersede" && (typeof body.supersededBy !== "string" || body.supersededBy.length === 0)) {
      return sendProblem(reply, "invalid_request", "supersededBy is required when action is supersede");
    }
    const rec = await ledger.setStatus(
      registryId,
      body.action,
      body.reason,
      body.supersededBy ?? null,
      req.tenantDid,
    );
    return reply.code(200).send(rec);
  });
}
