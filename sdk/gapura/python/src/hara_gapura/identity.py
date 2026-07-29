"""Identity resource: resolve DIDs, register, bindings."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any
from urllib.parse import quote

from .types import (
    Binding,
    DidResolution,
    IdentityRegistration,
    IdentityRequest,
    Operation,
    SubjectType,
)

if TYPE_CHECKING:
    from .client import GapuraClient

__all__ = ["Identity"]


class Identity:
    """``client.identity`` — resolve/register DIDs and manage Authentik bindings."""

    def __init__(self, client: "GapuraClient") -> None:
        self._client = client

    def resolve(self, did: str) -> DidResolution:
        """Resolve a ``did:hara`` DID (``GET /did/{did}``, scope ``identity:read``)."""
        return self._client._request("GET", f"did/{quote(did, safe='')}")

    def register(
        self,
        *,
        subject_type: SubjectType,
        display_name: str,
        controller_jwk: dict[str, Any] | None = None,
        namespace_hint: str | None = None,
    ) -> IdentityRegistration | Operation:
        """Issue/register a DID (``POST /identities``, scope ``identity:write``).

        Returns an :class:`IdentityRegistration` on ``201`` (confirmed) or an
        :class:`Operation` on ``202`` (Sidetree batching) — poll
        :meth:`operation` for the batched case.
        """
        body: IdentityRequest = {
            "subjectType": subject_type,
            "displayName": display_name,
        }
        if controller_jwk is not None:
            body["controllerJwk"] = controller_jwk
        if namespace_hint is not None:
            body["namespaceHint"] = namespace_hint
        return self._client._request("POST", "identities", json=body)

    def operation(self, op_id: str) -> Operation:
        """Poll a Sidetree-batched registration (``GET /identities/operations/{id}``)."""
        return self._client._request(
            "GET", f"identities/operations/{quote(op_id, safe='')}"
        )

    def binding_by_subject(self, sub: str) -> Binding:
        """DID bound to an Authentik subject (``GET /identities/by-subject/{sub}``)."""
        return self._client._request(
            "GET", f"identities/by-subject/{quote(sub, safe='')}"
        )

    def create_binding(
        self, did: str, authentik_sub: str, tenant: str
    ) -> Binding:
        """Bind a DID to an Authentik subject (``POST /identities/{did}/bindings``)."""
        return self._client._request(
            "POST",
            f"identities/{quote(did, safe='')}/bindings",
            json={"authentikSub": authentik_sub, "tenant": tenant},
        )
