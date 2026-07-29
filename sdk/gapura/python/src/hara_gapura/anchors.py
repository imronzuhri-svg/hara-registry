"""Anchoring resource: create, get, verify, status."""

from __future__ import annotations

import uuid
from typing import TYPE_CHECKING, Any

from .types import Anchor, AnchorRequest, AnchorStatus, HashAlg, VerifyResult

if TYPE_CHECKING:
    from .client import GapuraClient

__all__ = ["Anchors"]


class Anchors:
    """``client.anchors`` — anchor digests and verify them."""

    def __init__(self, client: "GapuraClient") -> None:
        self._client = client

    def create(
        self,
        digest: str,
        *,
        hash_alg: HashAlg = "sha256",
        object_did: str,
        purpose: str,
        actor_did: str | None = None,
        metadata: dict[str, Any] | None = None,
        idempotency_key: str | None = None,
    ) -> Anchor:
        """Anchor a digest (``POST /anchors``, scope ``anchor:write``).

        The digest is the natural idempotency key, so re-anchoring returns the
        existing anchor. A random uuid4 ``Idempotency-Key`` header is generated
        when one is not supplied so retries are always safe.
        """
        body: AnchorRequest = {
            "digest": digest,
            "hashAlg": hash_alg,
            "objectDid": object_did,
            "purpose": purpose,
        }
        if actor_did is not None:
            body["actorDid"] = actor_did
        if metadata is not None:
            body["metadata"] = metadata

        key = idempotency_key if idempotency_key is not None else str(uuid.uuid4())
        return self._client._request(
            "POST", "anchors", json=body, idempotency_key=key
        )

    def get(self, anchor_id: str) -> Anchor:
        """Fetch an anchor record (``GET /anchors/{anchorId}``)."""
        return self._client._request("GET", f"anchors/{anchor_id}")

    def verify(
        self, digest: str, *, hash_alg: HashAlg | None = None
    ) -> VerifyResult:
        """Verify whether a digest is anchored (``GET /anchors?digest=...``)."""
        return self._client._request(
            "GET",
            "anchors",
            params={"digest": digest, "hashAlg": hash_alg},
        )

    def status(self, anchor_id: str) -> AnchorStatus:
        """Anchor tx lifecycle (``GET /anchors/{anchorId}/status``)."""
        return self._client._request("GET", f"anchors/{anchor_id}/status")
