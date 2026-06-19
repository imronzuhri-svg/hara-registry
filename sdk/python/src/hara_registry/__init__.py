"""Official Python SDK for Hara Registry.

Hara Registry is a permissioned Hyperledger Besu (QBFT) chain for palm-oil
supply-chain traceability with post-quantum audit anchoring.

Quick start::

    from hara_registry import HaraRegistry

    reg = HaraRegistry()                  # public read endpoint, no key
    print(reg.chain.get_block_number())
    print(reg.palm_oil.balance_of(account, batch_id))

    # writes need a private key (and a pre-funded wallet — see README)
    txh = reg.palm_oil.set_approval_for_all(PRIVATE_KEY, relay_addr, True)
    reg.chain.wait_for_receipt(txh)       # raises if it reverted

The three rules that bite every integrator (enforced by this SDK): legacy
type-0 txs with ``gasPrice 0`` and ``chainId 131216``; pre-fund every wallet
with >= 1 wei before its first tx; and always verify ``receipt.status == 0x1``.
"""

from __future__ import annotations

from typing import Optional

from . import config
from .anchor import AnchorPayload, pq_signature_hash
from .chain import (
    ChainClient,
    ReceiptStatusError,
    ZeroBalanceWarning,
)
from .config import (
    ADDRESSES,
    CHAIN_ID,
    EXPLORER_URL,
    GAS_PRICE,
    MAX_RPC_BATCH,
    RPC_READ_URL,
    RPC_WRITE_URL,
    RPC_WS_URL,
    TRACE_URL,
    TX_TYPE_LEGACY,
)
from .contracts import (
    ContractRegistry,
    HaraPalmOil,
    PQAnchorRegistry,
    TraceabilityBatchRelay,
)
from .trace import BatchSummary, Hop, TraceClient

__version__ = "0.1.0"


class HaraRegistry:
    """Top-level facade wiring together the chain, contracts and trace clients.

    Args:
        private_key: Optional default signer for convenience; individual write
            methods still take an explicit ``private_key`` argument.
        read_url / write_url: Override the default public RPC endpoints.
        trace_user / trace_pass: HTTP Basic credentials for the trace API.
    """

    def __init__(
        self,
        private_key: Optional[str] = None,
        read_url: str = config.RPC_READ_URL,
        write_url: str = config.RPC_WRITE_URL,
        trace_url: str = config.TRACE_URL,
        trace_user: Optional[str] = None,
        trace_pass: Optional[str] = None,
    ) -> None:
        self.private_key = private_key
        self.chain = ChainClient(read_url=read_url, write_url=write_url)

        # Contract wrappers bound to the canonical deployed addresses.
        self.palm_oil = HaraPalmOil(self.chain)
        self.relay = TraceabilityBatchRelay(self.chain)
        self.registry = ContractRegistry(self.chain)
        self.pq_anchors = PQAnchorRegistry(self.chain)

        # Indexed REST view.
        self.trace = TraceClient(
            base_url=trace_url, username=trace_user, password=trace_pass
        )


__all__ = [
    "__version__",
    "HaraRegistry",
    # clients
    "ChainClient",
    "TraceClient",
    # contracts
    "HaraPalmOil",
    "TraceabilityBatchRelay",
    "ContractRegistry",
    "PQAnchorRegistry",
    # anchor helpers
    "AnchorPayload",
    "pq_signature_hash",
    # types
    "BatchSummary",
    "Hop",
    # errors / warnings
    "ReceiptStatusError",
    "ZeroBalanceWarning",
    # constants
    "config",
    "CHAIN_ID",
    "GAS_PRICE",
    "TX_TYPE_LEGACY",
    "MAX_RPC_BATCH",
    "ADDRESSES",
    "RPC_READ_URL",
    "RPC_WRITE_URL",
    "RPC_WS_URL",
    "EXPLORER_URL",
    "TRACE_URL",
]
