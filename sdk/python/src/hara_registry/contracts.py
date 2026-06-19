"""Typed-ish wrappers for the deployed Hara Registry contracts.

Each wrapper holds a minimal inline ABI (only the methods/events the SDK uses)
and exposes:

* **read methods** — executed as ``eth_call`` against the read node.
* **calldata builders** (``*_calldata``) — return the ABI-encoded ``bytes`` so
  the caller can submit them through :meth:`ChainClient.send_legacy_tx`.
* **send methods** — convenience that builds calldata and submits the tx,
  returning the tx hash (then call ``wait_for_receipt``).

All write paths route through :class:`~hara_registry.chain.ChainClient` so they
inherit the legacy / ``gasPrice 0`` / pre-fund / receipt-status conventions.
"""

from __future__ import annotations

from typing import Any, Optional

from web3 import Web3

from . import config
from .chain import ChainClient

# ---------------------------------------------------------------------------
# Inline minimal ABIs
# ---------------------------------------------------------------------------

HARA_PALM_OIL_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "balanceOf",
        "stateMutability": "view",
        "inputs": [
            {"name": "account", "type": "address"},
            {"name": "id", "type": "uint256"},
        ],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "isApprovedForAll",
        "stateMutability": "view",
        "inputs": [
            {"name": "account", "type": "address"},
            {"name": "operator", "type": "address"},
        ],
        "outputs": [{"name": "", "type": "bool"}],
    },
    {
        "type": "function",
        "name": "setApprovalForAll",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "operator", "type": "address"},
            {"name": "approved", "type": "bool"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "mintBatch",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "batchId", "type": "uint256"},
            {"name": "firstOwner", "type": "address"},
            {"name": "liters", "type": "uint256"},
            {"name": "rspoCertificateHash", "type": "bytes32"},
            {"name": "plantationId", "type": "bytes32"},
            {"name": "productionDate", "type": "uint64"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "batchMeta",
        "stateMutability": "view",
        "inputs": [{"name": "", "type": "uint256"}],
        "outputs": [
            {"name": "rspoCertificateHash", "type": "bytes32"},
            {"name": "plantationId", "type": "bytes32"},
            {"name": "productionDate", "type": "uint64"},
            {"name": "mintedAt", "type": "uint64"},
            {"name": "mintedBy", "type": "address"},
        ],
    },
    {
        "type": "event",
        "name": "TransferSingle",
        "inputs": [
            {"name": "operator", "type": "address", "indexed": True},
            {"name": "from", "type": "address", "indexed": True},
            {"name": "to", "type": "address", "indexed": True},
            {"name": "id", "type": "uint256", "indexed": False},
            {"name": "value", "type": "uint256", "indexed": False},
        ],
        "anonymous": False,
    },
    {
        "type": "event",
        "name": "BatchMinted",
        "inputs": [
            {"name": "batchId", "type": "uint256", "indexed": True},
            {"name": "firstOwner", "type": "address", "indexed": True},
            {"name": "liters", "type": "uint256", "indexed": False},
            {"name": "rspoCertificateHash", "type": "bytes32", "indexed": False},
            {"name": "plantationId", "type": "bytes32", "indexed": False},
            {"name": "productionDate", "type": "uint64", "indexed": False},
        ],
        "anonymous": False,
    },
]

TRACEABILITY_BATCH_RELAY_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "executeChain",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "token", "type": "address"},
            {"name": "batchId", "type": "uint256"},
            {"name": "amount", "type": "uint256"},
            {"name": "holders", "type": "address[]"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "executeChainVariable",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "token", "type": "address"},
            {"name": "batchId", "type": "uint256"},
            {"name": "holders", "type": "address[]"},
            {"name": "amounts", "type": "uint256[]"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "executeHops",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "token", "type": "address"},
            {"name": "batchId", "type": "uint256"},
            {"name": "froms", "type": "address[]"},
            {"name": "tos", "type": "address[]"},
            {"name": "amounts", "type": "uint256[]"},
        ],
        "outputs": [],
    },
    {
        "type": "event",
        "name": "ChainExecuted",
        "inputs": [
            {"name": "token", "type": "address", "indexed": True},
            {"name": "batchId", "type": "uint256", "indexed": True},
            {"name": "initiator", "type": "address", "indexed": True},
            {"name": "hopCount", "type": "uint16", "indexed": False},
            {"name": "firstHolder", "type": "address", "indexed": False},
            {"name": "finalHolder", "type": "address", "indexed": False},
        ],
        "anonymous": False,
    },
]

CONTRACT_REGISTRY_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "getActive",
        "stateMutability": "view",
        "inputs": [{"name": "name", "type": "bytes32"}],
        "outputs": [{"name": "", "type": "address"}],
    },
    {
        "type": "function",
        "name": "register",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "name", "type": "bytes32"},
            {"name": "version", "type": "uint64"},
            {"name": "addr", "type": "address"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "setActiveVersion",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "name", "type": "bytes32"},
            {"name": "version", "type": "uint64"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "getEntry",
        "stateMutability": "view",
        "inputs": [
            {"name": "name", "type": "bytes32"},
            {"name": "version", "type": "uint64"},
        ],
        "outputs": [
            {
                "name": "",
                "type": "tuple",
                "components": [
                    {"name": "addr", "type": "address"},
                    {"name": "version", "type": "uint64"},
                    {"name": "registeredAt", "type": "uint64"},
                    {"name": "active", "type": "bool"},
                ],
            }
        ],
    },
]

PQ_ANCHOR_REGISTRY_ABI: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "recordAnchor",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "merkleRoot", "type": "bytes32"},
            {"name": "sha3Root", "type": "bytes32"},
            {"name": "blockFrom", "type": "uint64"},
            {"name": "blockTo", "type": "uint64"},
            {"name": "eventCount", "type": "uint64"},
            {"name": "anchorChain", "type": "bytes32"},
            {"name": "pqSignatureHash", "type": "bytes32"},
        ],
        "outputs": [{"name": "anchorId", "type": "uint256"}],
    },
    {
        "type": "function",
        "name": "confirmExternalAnchor",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "anchorId", "type": "uint256"},
            {"name": "anchorTxHash", "type": "bytes32"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "rotatePQKey",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "newKeyHash", "type": "bytes32"},
            {"name": "newAlgorithm", "type": "string"},
        ],
        "outputs": [],
    },
    {
        "type": "function",
        "name": "anchorCount",
        "stateMutability": "view",
        "inputs": [],
        "outputs": [{"name": "", "type": "uint256"}],
    },
    {
        "type": "event",
        "name": "AnchorRecorded",
        "inputs": [
            {"name": "anchorId", "type": "uint256", "indexed": True},
            {"name": "merkleRoot", "type": "bytes32", "indexed": False},
            {"name": "sha3Root", "type": "bytes32", "indexed": False},
            {"name": "blockFrom", "type": "uint64", "indexed": False},
            {"name": "blockTo", "type": "uint64", "indexed": False},
            {"name": "eventCount", "type": "uint64", "indexed": False},
            {"name": "pqSignatureHash", "type": "bytes32", "indexed": False},
            {"name": "pqKeyHash", "type": "bytes32", "indexed": False},
            {"name": "anchorChain", "type": "bytes32", "indexed": False},
        ],
        "anonymous": False,
    },
]


def _as_bytes32(value: bytes | str) -> bytes:
    """Normalise a 32-byte value given as bytes or a ``0x`` hex string."""
    if isinstance(value, str):
        raw = bytes.fromhex(value[2:] if value.startswith("0x") else value)
    else:
        raw = value
    if len(raw) != 32:
        raise ValueError(f"expected 32 bytes, got {len(raw)}")
    return raw


class _BaseContract:
    """Shared plumbing: a read-side web3 contract + calldata encoding."""

    address: str
    abi: list[dict[str, Any]]

    def __init__(self, client: ChainClient, address: Optional[str] = None) -> None:
        self.client = client
        self.address = Web3.to_checksum_address(address or self.address)
        self._contract = client.contract(self.address, self.abi)

    def _encode(self, fn_name: str, *args: Any) -> bytes:
        """ABI-encode a function call into calldata bytes."""
        data = self._contract.encode_abi(fn_name, args=list(args))
        return bytes.fromhex(data[2:] if data.startswith("0x") else data)

    def _send(self, private_key: str, fn_name: str, *args: Any) -> str:
        """Encode + submit a call as a legacy tx; returns the tx hash."""
        calldata = self._encode(fn_name, *args)
        return self.client.send_legacy_tx(private_key, self.address, calldata)


class HaraPalmOil(_BaseContract):
    """ERC-1155 palm-oil batch token (1 token = 1 litre)."""

    address = config.HARA_PALM_OIL_ADDRESS
    abi = HARA_PALM_OIL_ABI

    def balance_of(self, account: str, batch_id: int) -> int:
        """Litres of ``batch_id`` held by ``account``."""
        return self._contract.functions.balanceOf(
            Web3.to_checksum_address(account), batch_id
        ).call()

    def is_approved_for_all(self, account: str, operator: str) -> bool:
        """Whether ``operator`` may move all of ``account``'s tokens."""
        return self._contract.functions.isApprovedForAll(
            Web3.to_checksum_address(account), Web3.to_checksum_address(operator)
        ).call()

    # -- writes --

    def set_approval_for_all_calldata(self, operator: str, approved: bool) -> bytes:
        return self._encode(
            "setApprovalForAll", Web3.to_checksum_address(operator), approved
        )

    def set_approval_for_all(
        self, private_key: str, operator: str, approved: bool
    ) -> str:
        """Approve/revoke ``operator`` as an operator for all tokens."""
        return self._send(
            private_key,
            "setApprovalForAll",
            Web3.to_checksum_address(operator),
            approved,
        )

    def mint_batch_calldata(
        self,
        batch_id: int,
        first_owner: str,
        liters: int,
        rspo_certificate_hash: bytes | str,
        plantation_id: bytes | str,
        production_date: int,
    ) -> bytes:
        return self._encode(
            "mintBatch",
            batch_id,
            Web3.to_checksum_address(first_owner),
            liters,
            _as_bytes32(rspo_certificate_hash),
            _as_bytes32(plantation_id),
            production_date,
        )

    def mint_batch(
        self,
        private_key: str,
        batch_id: int,
        first_owner: str,
        liters: int,
        rspo_certificate_hash: bytes | str,
        plantation_id: bytes | str,
        production_date: int,
    ) -> str:
        """Mint a new certified batch (MINTER_ROLE gated)."""
        return self._send(
            private_key,
            "mintBatch",
            batch_id,
            Web3.to_checksum_address(first_owner),
            liters,
            _as_bytes32(rspo_certificate_hash),
            _as_bytes32(plantation_id),
            production_date,
        )


class TraceabilityBatchRelay(_BaseContract):
    """Executes N custody hops of an ERC-1155 batch in one atomic tx."""

    address = config.TRACEABILITY_BATCH_RELAY_ADDRESS
    abi = TRACEABILITY_BATCH_RELAY_ABI

    def execute_chain_calldata(
        self, token: str, batch_id: int, amount: int, holders: list[str]
    ) -> bytes:
        return self._encode(
            "executeChain",
            Web3.to_checksum_address(token),
            batch_id,
            amount,
            [Web3.to_checksum_address(h) for h in holders],
        )

    def execute_chain(
        self,
        private_key: str,
        token: str,
        batch_id: int,
        amount: int,
        holders: list[str],
    ) -> str:
        """Move ``amount`` down a line of ``holders`` (uniform per hop)."""
        return self._send(
            private_key,
            "executeChain",
            Web3.to_checksum_address(token),
            batch_id,
            amount,
            [Web3.to_checksum_address(h) for h in holders],
        )

    def execute_chain_variable(
        self,
        private_key: str,
        token: str,
        batch_id: int,
        holders: list[str],
        amounts: list[int],
    ) -> str:
        """Move per-leg ``amounts`` down ``holders`` (len == holders-1)."""
        if len(amounts) != len(holders) - 1:
            raise ValueError("amounts must have length len(holders) - 1")
        return self._send(
            private_key,
            "executeChainVariable",
            Web3.to_checksum_address(token),
            batch_id,
            [Web3.to_checksum_address(h) for h in holders],
            amounts,
        )

    def execute_hops(
        self,
        private_key: str,
        token: str,
        batch_id: int,
        froms: list[str],
        tos: list[str],
        amounts: list[int],
    ) -> str:
        """Execute an arbitrary, topologically-ordered DAG of hops."""
        if not (len(froms) == len(tos) == len(amounts)):
            raise ValueError("froms, tos and amounts must be the same length")
        return self._send(
            private_key,
            "executeHops",
            Web3.to_checksum_address(token),
            batch_id,
            [Web3.to_checksum_address(a) for a in froms],
            [Web3.to_checksum_address(a) for a in tos],
            amounts,
        )


class ContractRegistry(_BaseContract):
    """name -> address registry. ``name`` is ``keccak256(utf8(name))``."""

    address = config.CONTRACT_REGISTRY_ADDRESS
    abi = CONTRACT_REGISTRY_ABI

    @staticmethod
    def name_hash(name: str) -> bytes:
        """``keccak256(utf8(name))`` — how every entry is keyed.

        NOT ``format-bytes32-string`` / a padded ASCII string.
        """
        return Web3.keccak(text=name)

    def get_active(self, name: str) -> str:
        """Active address for logical contract ``name``."""
        return self._contract.functions.getActive(self.name_hash(name)).call()

    def get_entry(self, name: str, version: int) -> dict[str, Any]:
        """Full entry tuple for ``name`` at ``version``."""
        addr, ver, registered_at, active = self._contract.functions.getEntry(
            self.name_hash(name), version
        ).call()
        return {
            "addr": addr,
            "version": ver,
            "registeredAt": registered_at,
            "active": active,
        }

    def register_calldata(self, name: str, version: int, addr: str) -> bytes:
        # version is uint64 (an int) — NOT a padded ASCII string.
        return self._encode(
            "register",
            self.name_hash(name),
            int(version),
            Web3.to_checksum_address(addr),
        )

    def register(self, private_key: str, name: str, version: int, addr: str) -> str:
        """Register ``addr`` for ``name`` at integer ``version`` (uint64)."""
        return self._send(
            private_key,
            "register",
            self.name_hash(name),
            int(version),
            Web3.to_checksum_address(addr),
        )


class PQAnchorRegistry(_BaseContract):
    """Post-quantum (ML-DSA-65) audit anchor registry."""

    address = config.PQ_ANCHOR_REGISTRY_ADDRESS
    abi = PQ_ANCHOR_REGISTRY_ABI

    def anchor_count(self) -> int:
        """Total number of anchors recorded."""
        return self._contract.functions.anchorCount().call()

    def record_anchor_calldata(
        self,
        merkle_root: bytes | str,
        sha3_root: bytes | str,
        block_from: int,
        block_to: int,
        event_count: int,
        anchor_chain: bytes | str,
        pq_signature_hash: bytes | str,
    ) -> bytes:
        """Encode ``recordAnchor`` calldata.

        ``pq_signature_hash`` is ``keccak256(ML-DSA signature bytes)`` and MUST
        be non-zero (the contract reverts with ``MissingPQCommitment``). The
        actual ML-DSA signing is the caller's job — see :mod:`hara_registry.anchor`.
        """
        return self._encode(
            "recordAnchor",
            _as_bytes32(merkle_root),
            _as_bytes32(sha3_root),
            block_from,
            block_to,
            event_count,
            _as_bytes32(anchor_chain),
            _as_bytes32(pq_signature_hash),
        )

    def record_anchor(
        self,
        private_key: str,
        merkle_root: bytes | str,
        sha3_root: bytes | str,
        block_from: int,
        block_to: int,
        event_count: int,
        anchor_chain: bytes | str,
        pq_signature_hash: bytes | str,
    ) -> str:
        """Submit ``recordAnchor`` (ANCHOR_ROLE gated). Returns the tx hash."""
        return self._send(
            private_key,
            "recordAnchor",
            _as_bytes32(merkle_root),
            _as_bytes32(sha3_root),
            block_from,
            block_to,
            event_count,
            _as_bytes32(anchor_chain),
            _as_bytes32(pq_signature_hash),
        )
