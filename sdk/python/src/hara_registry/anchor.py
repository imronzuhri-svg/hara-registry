"""Helpers for building post-quantum audit anchors.

The :class:`~hara_registry.contracts.PQAnchorRegistry` commits a *hash* of an
ML-DSA-65 (Dilithium-3, NIST FIPS 204) signature on-chain; the ~3 KB signature
blob itself lives off-chain (MinIO bucket ``hara-pq-anchors``).

**The actual ML-DSA signing is the caller's job.** This SDK does not bundle a
post-quantum signer — you produce the signature with your own ML-DSA toolchain
(e.g. liboqs / ``oqs-python`` / a HSM), then pass its bytes here to derive the
``pqSignatureHash`` commitment, and store the raw signature off-chain yourself.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

from web3 import Web3

from .chain import ChainClient
from .contracts import PQAnchorRegistry


def pq_signature_hash(ml_dsa_signature: bytes) -> bytes:
    """``keccak256(ML-DSA signature bytes)`` — the on-chain PQ commitment.

    Must be non-zero; the contract reverts with ``MissingPQCommitment`` for an
    all-zero hash. Sign the Merkle root with your ML-DSA-65 key off-chain, then
    pass the raw signature bytes here.
    """
    digest = Web3.keccak(ml_dsa_signature)
    if digest == b"\x00" * 32:
        raise ValueError("pqSignatureHash is zero — provide a real ML-DSA signature")
    return digest


@dataclass
class AnchorPayload:
    """Everything ``recordAnchor`` needs, with the PQ commitment derived.

    ``anchor_chain`` is a free-form bytes32 tag for the external chain the
    anchor is mirrored to (IOTA / Ethereum L1 tx ref, etc.); use 32 zero bytes
    if there is no external mirror.
    """

    merkle_root: bytes
    sha3_root: bytes
    block_from: int
    block_to: int
    event_count: int
    pq_signature_hash: bytes
    anchor_chain: bytes = b"\x00" * 32

    @classmethod
    def build(
        cls,
        merkle_root: bytes,
        sha3_root: bytes,
        block_from: int,
        block_to: int,
        event_count: int,
        ml_dsa_signature: bytes,
        anchor_chain: bytes = b"\x00" * 32,
    ) -> "AnchorPayload":
        """Build a payload, deriving ``pq_signature_hash`` from the signature."""
        if block_to < block_from:
            raise ValueError("block_to must be >= block_from (EmptyRange)")
        return cls(
            merkle_root=merkle_root,
            sha3_root=sha3_root,
            block_from=block_from,
            block_to=block_to,
            event_count=event_count,
            pq_signature_hash=pq_signature_hash(ml_dsa_signature),
            anchor_chain=anchor_chain,
        )

    def record_anchor_calldata(self, registry: PQAnchorRegistry) -> bytes:
        """Encode this payload as ``recordAnchor`` calldata."""
        return registry.record_anchor_calldata(
            self.merkle_root,
            self.sha3_root,
            self.block_from,
            self.block_to,
            self.event_count,
            self.anchor_chain,
            self.pq_signature_hash,
        )

    def submit(
        self,
        client: ChainClient,
        private_key: str,
        registry: Optional[PQAnchorRegistry] = None,
    ) -> str:
        """Submit ``recordAnchor`` as a legacy tx; returns the tx hash."""
        registry = registry or PQAnchorRegistry(client)
        return registry.record_anchor(
            private_key,
            self.merkle_root,
            self.sha3_root,
            self.block_from,
            self.block_to,
            self.event_count,
            self.anchor_chain,
            self.pq_signature_hash,
        )
