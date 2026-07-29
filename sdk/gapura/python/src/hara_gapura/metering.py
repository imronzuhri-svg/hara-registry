"""Metering resource: geometry-blind usage and quotas."""

from __future__ import annotations

from typing import TYPE_CHECKING

from .types import Granularity, Quotas, Usage

if TYPE_CHECKING:
    from .client import GapuraClient

__all__ = ["Metering"]


class Metering:
    """``client.metering`` — usage counters and quotas for a tenant."""

    def __init__(self, client: "GapuraClient") -> None:
        self._client = client

    def usage(
        self,
        *,
        tenant: str,
        from_: str,
        to: str,
        granularity: Granularity | None = None,
        metric: str | None = None,
    ) -> Usage:
        """Query usage (``GET /metering/usage``, scope ``metering:read``).

        ``from_`` and ``to`` are ISO dates (``YYYY-MM-DD``); ``from_`` maps to the
        ``from`` query parameter (``from`` is a Python keyword).
        """
        return self._client._request(
            "GET",
            "metering/usage",
            params={
                "tenant": tenant,
                "from": from_,
                "to": to,
                "granularity": granularity,
                "metric": metric,
            },
        )

    def quotas(self, tenant: str) -> Quotas:
        """Current limits + consumption (``GET /metering/quotas``)."""
        return self._client._request(
            "GET", "metering/quotas", params={"tenant": tenant}
        )
