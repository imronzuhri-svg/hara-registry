"""Canonical configuration for Hara Registry.

Every value here is sourced from ``doc/api/hara-registry-facts.md`` (the single
source of truth, verified against the live chain on 2026-06-08). Do not invent
values — if the chain changes, update the facts file first, then propagate here.
"""

from __future__ import annotations

from typing import Final

# --- Chain identity (INVARIANTS — never change) ----------------------------

#: Chain ID of the Hara Registry Besu (QBFT) network.
CHAIN_ID: Final[int] = 131216

#: Gas price is always zero — the chain uses a ``zeroBaseFee`` genesis.
GAS_PRICE: Final[int] = 0

#: Only legacy (type-0) transactions are accepted; EIP-1559 type-2 is rejected.
TX_TYPE_LEGACY: Final[int] = 0

#: Maximum JSON-RPC batch size on the public load balancer.
MAX_RPC_BATCH: Final[int] = 200

# --- Public endpoints ------------------------------------------------------
# NB: the trailing slash on /read/ and /write/ is REQUIRED — "/read" (no slash)
# returns 404. Reads go to /read/ (cached); writes to /write/.

RPC_READ_URL: Final[str] = "https://rpc.ledger.haratrust.io/read/"
RPC_WRITE_URL: Final[str] = "https://rpc.ledger.haratrust.io/write/"
RPC_WS_URL: Final[str] = "wss://rpc.ledger.haratrust.io/ws"
EXPLORER_URL: Final[str] = "https://explorer.ledger.haratrust.io/"
TRACE_URL: Final[str] = "https://trace.ledger.haratrust.io/"

# --- Deployed contract addresses (chain 131216) ----------------------------

ADDRESSES: Final[dict[str, str]] = {
    "HaraPalmOil": "0xa513E6E4b8f2a923D98304ec87F64353C4D5C853",
    "TraceabilityBatchRelay": "0x2279B7A0a67DB372996a5FaB50D91eAA73d2eBe6",
    "PQAnchorRegistry": "0x8A791620dd6260079BF849Dc5567aDC3F2FdC318",
    "ContractRegistry": "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512",
    "GovernanceContract": "0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9",
    "AnchorRegistry": "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
}

# Convenience aliases (checksummed addresses as deployed).
HARA_PALM_OIL_ADDRESS: Final[str] = ADDRESSES["HaraPalmOil"]
TRACEABILITY_BATCH_RELAY_ADDRESS: Final[str] = ADDRESSES["TraceabilityBatchRelay"]
PQ_ANCHOR_REGISTRY_ADDRESS: Final[str] = ADDRESSES["PQAnchorRegistry"]
CONTRACT_REGISTRY_ADDRESS: Final[str] = ADDRESSES["ContractRegistry"]
GOVERNANCE_CONTRACT_ADDRESS: Final[str] = ADDRESSES["GovernanceContract"]
ANCHOR_REGISTRY_ADDRESS: Final[str] = ADDRESSES["AnchorRegistry"]
