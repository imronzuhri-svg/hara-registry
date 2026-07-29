"""HTTP client for the HARA Gapura Gateway."""

from __future__ import annotations

import time
from typing import Any, Mapping
from urllib.parse import urljoin

import requests

from .auth import AuthProvider
from .errors import ProblemError

__all__ = ["GapuraClient"]

_DEFAULT_TIMEOUT = 30.0
_MAX_RETRIES = 3
_BACKOFF_BASE = 0.5  # seconds; exponential: 0.5, 1.0, 2.0
_RETRY_STATUSES = frozenset({429, 503})


class GapuraClient:
    """Thin, typed, synchronous client over the Gapura Gateway.

    Attaches the Bearer token from ``auth`` to every request, encodes an
    ``Idempotency-Key`` on writes that supply one, parses
    ``application/problem+json`` bodies into :class:`ProblemError`, and retries
    ``429`` (respecting ``Retry-After``) and ``503`` with exponential backoff
    up to 3 attempts.

    Sub-resources: :attr:`anchors`, :attr:`identity`, :attr:`metering`.
    """

    def __init__(
        self,
        base_url: str,
        auth: AuthProvider,
        session: requests.Session | None = None,
        *,
        timeout: float = _DEFAULT_TIMEOUT,
        max_retries: int = _MAX_RETRIES,
        user_agent: str = "hara-gapura-python/0.1.0",
    ) -> None:
        # Normalise so urljoin against a path keeps the "/v1" prefix.
        self.base_url = base_url if base_url.endswith("/") else base_url + "/"
        self.auth = auth
        self.session = session or requests.Session()
        self.timeout = timeout
        self.max_retries = max_retries
        self.user_agent = user_agent

        # Local imports avoid a circular import at module load.
        from .anchors import Anchors
        from .identity import Identity
        from .metering import Metering

        self.anchors = Anchors(self)
        self.identity = Identity(self)
        self.metering = Metering(self)

    # -- internals -----------------------------------------------------------

    def _url(self, path: str) -> str:
        return urljoin(self.base_url, path.lstrip("/"))

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: Mapping[str, Any] | None = None,
        json: Any | None = None,
        idempotency_key: str | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        """Perform a request and return the parsed JSON body (or ``None``).

        Raises :class:`ProblemError` on any non-2xx response.
        """
        url = self._url(path)
        # Drop query params that are None so callers can pass optionals freely.
        clean_params = (
            {k: v for k, v in params.items() if v is not None}
            if params is not None
            else None
        )

        attempt = 0
        while True:
            attempt += 1
            request_headers: dict[str, str] = {
                "Accept": "application/json",
                "User-Agent": self.user_agent,
                "Authorization": self.auth.auth_header(),
            }
            if idempotency_key is not None:
                request_headers["Idempotency-Key"] = idempotency_key
            if headers:
                request_headers.update(headers)

            try:
                resp = self.session.request(
                    method,
                    url,
                    params=clean_params,
                    json=json,
                    headers=request_headers,
                    timeout=self.timeout,
                )
            except requests.RequestException as exc:
                if attempt < self.max_retries:
                    time.sleep(_BACKOFF_BASE * (2 ** (attempt - 1)))
                    continue
                raise ProblemError(
                    status=503,
                    code="chain_unavailable",
                    title="Network error contacting Gapura Gateway",
                    detail=str(exc),
                ) from exc

            if resp.status_code in _RETRY_STATUSES and attempt < self.max_retries:
                self._sleep_before_retry(resp, attempt)
                continue

            if resp.status_code >= 400:
                raise self._to_problem(resp)

            return self._parse_body(resp)

    @staticmethod
    def _sleep_before_retry(resp: requests.Response, attempt: int) -> None:
        delay = _BACKOFF_BASE * (2 ** (attempt - 1))
        if resp.status_code == 429:
            retry_after = resp.headers.get("Retry-After")
            if retry_after:
                try:
                    delay = max(delay, float(retry_after))
                except ValueError:
                    # HTTP-date form is not parsed; fall back to backoff.
                    pass
        time.sleep(delay)

    @staticmethod
    def _to_problem(resp: requests.Response) -> ProblemError:
        content_type = resp.headers.get("Content-Type", "")
        if "json" in content_type:
            try:
                body = resp.json()
            except ValueError:
                body = None
            if isinstance(body, dict):
                return ProblemError.from_problem(resp.status_code, body)
        return ProblemError(
            status=resp.status_code,
            title=resp.reason or None,
            detail=(resp.text or None),
        )

    @staticmethod
    def _parse_body(resp: requests.Response) -> Any:
        if resp.status_code == 204 or not resp.content:
            return None
        content_type = resp.headers.get("Content-Type", "")
        if "json" in content_type:
            return resp.json()
        return resp.text
