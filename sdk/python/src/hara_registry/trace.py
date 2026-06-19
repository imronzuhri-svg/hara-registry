"""Client for the Traceability REST API (``trace.ledger.haratrust.io``).

The trace API is the indexed, query-friendly view over the on-chain ERC-1155
custody events. It is protected by **HTTP Basic auth**. All amounts are in
litres and returned as strings. Responses map to the dataclasses below, which
mirror the schemas in ``doc/api/hara-registry-facts.md``.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional
from urllib.parse import quote, urljoin

import requests

from . import config


@dataclass
class BatchSummary:
    """One palm-oil batch as indexed by the trace API."""

    batch_id: str
    initial_liters: str
    first_owner: str
    current_holder: str
    hop_count: str
    rspo_hash: str
    plantation_id: str
    production_date: str
    minted_at: str
    last_hop_at: Optional[str] = None

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "BatchSummary":
        return cls(
            batch_id=d["batch_id"],
            initial_liters=d["initial_liters"],
            first_owner=d["first_owner"],
            current_holder=d["current_holder"],
            hop_count=d["hop_count"],
            rspo_hash=d["rspo_hash"],
            plantation_id=d["plantation_id"],
            production_date=d["production_date"],
            minted_at=d["minted_at"],
            last_hop_at=d.get("last_hop_at"),
        )


@dataclass
class Hop:
    """A single custody hop (one ERC-1155 ``TransferSingle``)."""

    batch_id: str
    liters: str
    from_addr: str
    to_addr: str
    operator_addr: str
    tx_hash: str
    block_number: str
    log_index: int
    occurred_at: str

    @classmethod
    def from_dict(cls, d: dict[str, Any]) -> "Hop":
        return cls(
            batch_id=d["batch_id"],
            liters=d["liters"],
            from_addr=d["from_addr"],
            to_addr=d["to_addr"],
            operator_addr=d["operator_addr"],
            tx_hash=d["tx_hash"],
            block_number=d["block_number"],
            log_index=d["log_index"],
            occurred_at=d["occurred_at"],
        )


class TraceClient:
    """REST client for the traceability indexer.

    Args:
        base_url: API root. Defaults to the public endpoint.
        username / password: HTTP Basic credentials (the API requires auth).
        timeout: Per-request timeout in seconds.
    """

    def __init__(
        self,
        base_url: str = config.TRACE_URL,
        username: Optional[str] = None,
        password: Optional[str] = None,
        timeout: float = 30.0,
    ) -> None:
        self.base_url = base_url if base_url.endswith("/") else base_url + "/"
        self.timeout = timeout
        self._session = requests.Session()
        if username is not None and password is not None:
            self._session.auth = (username, password)

    def _get(self, path: str, params: Optional[dict[str, Any]] = None) -> Any:
        url = urljoin(self.base_url, path.lstrip("/"))
        resp = self._session.get(url, params=params, timeout=self.timeout)
        resp.raise_for_status()
        return resp.json()

    # -- endpoints ----------------------------------------------------------

    def list_batches(self, limit: int = 50, offset: int = 0) -> list[BatchSummary]:
        """List batches (newest ``minted_at`` first)."""
        data = self._get("v1/batches", params={"limit": limit, "offset": offset})
        return [BatchSummary.from_dict(item) for item in data.get("items", [])]

    def get_batch(self, batch_id: str) -> BatchSummary:
        """Fetch one batch by id (raises ``HTTPError`` 404 if not found)."""
        data = self._get(f"v1/batches/{quote(str(batch_id))}")
        return BatchSummary.from_dict(data)

    def get_hops(self, batch_id: str) -> list[Hop]:
        """Custody hops for a batch, in order (block, then log index)."""
        data = self._get(f"v1/batches/{quote(str(batch_id))}/hops")
        return [Hop.from_dict(h) for h in data.get("hops", [])]

    def get_graph(self, batch_id: str, aggregate: bool = True) -> dict[str, Any]:
        """Custody graph (Cytoscape/React-Flow ready).

        ``aggregate=True`` collapses parallel A->B transfers into one weighted
        edge (best for the DAG view); ``False`` yields one edge per transfer.
        Returns the raw ``{ batch, nodes, edges, aggregated }`` dict.
        """
        return self._get(
            f"v1/batches/{quote(str(batch_id))}/graph",
            params={"aggregate": str(aggregate).lower()},
        )

    def holder_batches(self, address: str) -> list[str]:
        """Batch ids currently held by ``address`` (case-sensitive match)."""
        data = self._get(f"v1/holders/{quote(address)}/batches")
        return data.get("batches", [])

    def healthz(self) -> bool:
        """``True`` when the indexer reports healthy."""
        url = urljoin(self.base_url, "healthz")
        resp = self._session.get(url, timeout=self.timeout)
        return resp.status_code == 200
