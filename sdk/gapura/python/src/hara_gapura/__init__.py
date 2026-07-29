"""hara_gapura — Python client SDK for the HARA Gapura Gateway.

Anchoring (hashes only), identity (``did:hara`` / Numira), and geometry-blind
usage metering over the HARA-operated Gapura Gateway. Auth is OAuth2
client-credentials via Authentik.

Quickstart::

    from hara_gapura import GapuraClient, ClientCredentialsAuth

    auth = ClientCredentialsAuth(
        client_id="gapura-backend",
        client_secret="...",
        scope=["anchor:write", "anchor:read", "identity:read", "metering:read"],
    )
    gap = GapuraClient("https://gapura.ledger.haratrust.io/v1", auth=auth)
    anchor = gap.anchors.create(
        digest="0x9b2c...", hash_alg="sha256",
        object_did="did:hara:obj:mp:8f3a...", purpose="map-passport",
    )
"""

from __future__ import annotations

from .anchors import Anchors
from .auth import AuthProvider, ClientCredentialsAuth, StaticTokenAuth
from .client import GapuraClient
from .errors import ProblemError
from .identity import Identity
from .metering import Metering
from .types import (
    Anchor,
    AnchorRecord,
    AnchorRequest,
    AnchorStatus,
    AnchorStatusValue,
    AnchoredBy,
    Backing,
    Binding,
    Cost,
    DidDocumentMetadata,
    DidResolution,
    Granularity,
    HashAlg,
    IdentityRegistration,
    IdentityRequest,
    Metrics,
    Operation,
    OperationState,
    Period,
    Problem,
    QuotaEntry,
    Quotas,
    Registration,
    RegistrationState,
    Scope,
    Signatures,
    SubjectType,
    TxRef,
    Usage,
    Verification,
    VerifyResult,
)

__version__ = "0.1.0"

__all__ = [
    "__version__",
    # Client + resources
    "GapuraClient",
    "Anchors",
    "Identity",
    "Metering",
    # Auth
    "AuthProvider",
    "ClientCredentialsAuth",
    "StaticTokenAuth",
    # Errors
    "ProblemError",
    # Literals
    "HashAlg",
    "AnchorStatusValue",
    "Scope",
    "SubjectType",
    "Backing",
    "RegistrationState",
    "OperationState",
    "Granularity",
    # Types
    "AnchorRequest",
    "Anchor",
    "AnchorRecord",
    "AnchoredBy",
    "Verification",
    "VerifyResult",
    "AnchorStatus",
    "Cost",
    "TxRef",
    "Signatures",
    "DidResolution",
    "DidDocumentMetadata",
    "IdentityRequest",
    "IdentityRegistration",
    "Registration",
    "Operation",
    "Binding",
    "Usage",
    "Period",
    "Metrics",
    "Quotas",
    "QuotaEntry",
    "Problem",
]
