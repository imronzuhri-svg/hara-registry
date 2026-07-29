"""Typed models for the HARA Gapura Gateway API.

These mirror ``openapi-gapura.yaml`` exactly. Response bodies are represented as
``TypedDict`` (``total=False`` so additive fields never break parsing — clients
must ignore unknown fields per the versioning policy). Literals capture the
enum-ish fields (hash algorithms, statuses, OAuth scopes).
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

__all__ = [
    "HashAlg",
    "AnchorStatusValue",
    "Scope",
    "SubjectType",
    "Backing",
    "RegistrationState",
    "OperationState",
    "Granularity",
    "TxRef",
    "Signatures",
    "AnchorRequest",
    "Anchor",
    "Verification",
    "AnchoredBy",
    "AnchorRecord",
    "VerifyResult",
    "Cost",
    "AnchorStatus",
    "DidDocumentMetadata",
    "DidResolution",
    "IdentityRequest",
    "Registration",
    "IdentityRegistration",
    "Operation",
    "Binding",
    "Period",
    "Metrics",
    "Usage",
    "QuotaEntry",
    "Quotas",
    "Problem",
]

# --- Literals / enums -------------------------------------------------------

HashAlg = Literal["sha256", "keccak256"]
AnchorStatusValue = Literal["pending", "confirmed", "failed"]
Scope = Literal[
    "anchor:write",
    "anchor:read",
    "identity:read",
    "identity:write",
    "metering:read",
]
SubjectType = Literal["authority", "tenant-org", "actor"]
Backing = Literal["on-chain-issuer", "sidetree"]
RegistrationState = Literal["confirmed", "batching"]
OperationState = Literal["batching", "confirmed", "failed"]
Granularity = Literal["total", "day", "month"]


# --- Anchoring --------------------------------------------------------------

class TxRef(TypedDict, total=False):
    chainId: int
    contract: str
    txHash: str
    onChainId: str
    blockNumber: int
    logIndex: int


class Signatures(TypedDict, total=False):
    ecdsa: bool
    mlDsa65: bool


class AnchorRequest(TypedDict, total=False):
    digest: str  # REQUIRED
    hashAlg: HashAlg
    objectDid: str  # REQUIRED
    purpose: str  # REQUIRED
    actorDid: str
    metadata: dict[str, Any]


class Anchor(TypedDict, total=False):
    anchorId: str
    onChainId: str
    digest: str
    objectDid: str
    purpose: str
    status: AnchorStatusValue
    txRef: TxRef
    pqKeyHash: str
    signatures: Signatures
    anchoredAt: str


class Verification(TypedDict, total=False):
    ecdsaOnChain: bool
    pqVerified: bool
    pqKeyHash: str


class AnchoredBy(TypedDict, total=False):
    tenant: str
    actorDid: str


class AnchorRecord(TypedDict, total=False):
    anchorId: str
    objectDid: str
    purpose: str
    anchoredBy: AnchoredBy
    anchoredAt: str
    txRef: TxRef
    verification: Verification
    status: AnchorStatusValue


class VerifyResult(TypedDict, total=False):
    digest: str
    anchored: bool
    anchors: list[AnchorRecord]
    asOf: str


class Cost(TypedDict, total=False):
    gas: str
    unit: str
    note: str


class AnchorStatus(TypedDict, total=False):
    anchorId: str
    status: AnchorStatusValue
    confirmations: int
    blockNumber: int | None
    cost: Cost
    signatures: Signatures
    failureReason: str | None


# --- Identity ---------------------------------------------------------------

class DidDocumentMetadata(TypedDict, total=False):
    anchored: bool
    created: str
    updated: str
    deactivated: bool
    backing: Backing


class DidResolution(TypedDict, total=False):
    didDocument: dict[str, Any]
    didResolutionMetadata: dict[str, Any]
    didDocumentMetadata: DidDocumentMetadata


class IdentityRequest(TypedDict, total=False):
    subjectType: SubjectType  # REQUIRED
    displayName: str  # REQUIRED
    controllerJwk: dict[str, Any]
    namespaceHint: str


class Registration(TypedDict, total=False):
    backing: Backing
    txRef: TxRef
    state: RegistrationState


class IdentityRegistration(TypedDict, total=False):
    did: str
    didDocument: dict[str, Any]
    registration: Registration


class Operation(TypedDict, total=False):
    operationId: str
    state: OperationState
    did: str


class Binding(TypedDict, total=False):
    authentikSub: str
    did: str
    tenant: str
    boundAt: str


# --- Metering ---------------------------------------------------------------

class Period(TypedDict, total=False):
    from_: str
    to: str
    granularity: str


class Metrics(TypedDict, total=False):
    numiraIdResolutions: int
    atlasDidMints: int
    passportVerifications: int
    anchorTxCount: int
    anchorCostUnits: int


class Usage(TypedDict, total=False):
    tenant: str
    period: dict[str, Any]
    metrics: Metrics
    series: list[dict[str, Any]]
    quotas: dict[str, Any]
    generatedAt: str


class QuotaEntry(TypedDict, total=False):
    limit: int
    used: int
    resetsAt: str


class Quotas(TypedDict, total=False):
    tenant: str
    quotas: dict[str, QuotaEntry]


# --- Errors -----------------------------------------------------------------

class Problem(TypedDict, total=False):
    type: str
    title: str
    status: int
    code: str
    detail: str
    instance: str
    traceId: str
