"""Authentication providers for the Gapura Gateway.

Service-to-service auth is OAuth2 client-credentials via Authentik (ADR-0018):
the backend exchanges its client id/secret for a short-lived JWT and sends it as
``Authorization: Bearer <jwt>``. :class:`ClientCredentialsAuth` performs that
exchange, caches the token, and refreshes it ~30s before expiry.
"""

from __future__ import annotations

import threading
import time
from typing import Iterable, Protocol, runtime_checkable

import requests

__all__ = ["AuthProvider", "ClientCredentialsAuth", "StaticTokenAuth"]

# Default Authentik token endpoint (see gapura-integration-guide.md §2).
DEFAULT_TOKEN_URL = "https://auth.haratrust.io/application/o/token/"

# Refresh this many seconds before the token actually expires.
_REFRESH_SKEW_SECONDS = 30


@runtime_checkable
class AuthProvider(Protocol):
    """Anything that can supply an ``Authorization`` header value."""

    def auth_header(self) -> str:
        """Return the full header value, e.g. ``"Bearer eyJ..."``."""
        ...


class StaticTokenAuth:
    """Wrap a pre-obtained bearer token (useful for tests / injected tokens)."""

    def __init__(self, token: str) -> None:
        self._token = token

    def auth_header(self) -> str:
        return f"Bearer {self._token}"


class ClientCredentialsAuth:
    """OAuth2 client-credentials flow against Authentik with token caching.

    The token is fetched lazily on first use, cached in memory, and refreshed
    automatically ~30s before it expires. Thread-safe.
    """

    def __init__(
        self,
        client_id: str,
        client_secret: str,
        *,
        token_url: str = DEFAULT_TOKEN_URL,
        scope: str | Iterable[str] | None = None,
        session: requests.Session | None = None,
        timeout: float = 30.0,
    ) -> None:
        self.client_id = client_id
        self.client_secret = client_secret
        self.token_url = token_url
        if scope is None:
            self.scope: str | None = None
        elif isinstance(scope, str):
            self.scope = scope
        else:
            self.scope = " ".join(scope)
        self._session = session or requests.Session()
        self._timeout = timeout

        self._lock = threading.Lock()
        self._access_token: str | None = None
        self._expires_at: float = 0.0

    def auth_header(self) -> str:
        return f"Bearer {self.token()}"

    def token(self) -> str:
        """Return a valid access token, refreshing if needed."""
        now = time.monotonic()
        with self._lock:
            if self._access_token is not None and now < self._expires_at:
                return self._access_token
            return self._refresh_locked()

    def _refresh_locked(self) -> str:
        data = {
            "grant_type": "client_credentials",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
        }
        if self.scope:
            data["scope"] = self.scope

        resp = self._session.post(
            self.token_url,
            data=data,
            headers={
                "Accept": "application/json",
                "Content-Type": "application/x-www-form-urlencoded",
            },
            timeout=self._timeout,
        )
        resp.raise_for_status()
        payload = resp.json()

        token = payload.get("access_token")
        if not token:
            raise RuntimeError("Authentik token response missing 'access_token'")
        expires_in = float(payload.get("expires_in", 300))

        self._access_token = token
        self._expires_at = time.monotonic() + max(
            expires_in - _REFRESH_SKEW_SECONDS, 0.0
        )
        return token
