"""RFC 9457 ``application/problem+json`` error type."""

from __future__ import annotations

from typing import Any

from .types import Problem

__all__ = ["ProblemError"]


class ProblemError(Exception):
    """Raised when the Gateway returns an RFC 9457 problem document.

    Carries the structured problem fields. ``code`` is the stable machine code
    (e.g. ``invalid_digest``, ``forbidden_scope``, ``rate_limited``) that callers
    should branch on rather than parsing ``detail``.
    """

    def __init__(
        self,
        *,
        status: int,
        code: str | None = None,
        title: str | None = None,
        detail: str | None = None,
        type: str | None = None,
        instance: str | None = None,
        trace_id: str | None = None,
        problem: Problem | None = None,
    ) -> None:
        self.status: int = status
        self.code: str | None = code
        self.title: str | None = title
        self.detail: str | None = detail
        self.type: str | None = type
        self.instance: str | None = instance
        self.trace_id: str | None = trace_id
        # The raw problem document as received (may hold additive fields).
        self.problem: Problem = problem if problem is not None else {}

        parts = [f"{status}"]
        if code:
            parts.append(code)
        message = " ".join(parts)
        if title:
            message = f"{message}: {title}"
        if detail:
            message = f"{message} - {detail}"
        super().__init__(message)

    @classmethod
    def from_problem(cls, status: int, problem: dict[str, Any]) -> "ProblemError":
        """Build from a parsed problem+json body (falls back to ``status``)."""
        return cls(
            status=int(problem.get("status", status) or status),
            code=problem.get("code"),
            title=problem.get("title"),
            detail=problem.get("detail"),
            type=problem.get("type"),
            instance=problem.get("instance"),
            trace_id=problem.get("traceId"),
            problem=problem,  # type: ignore[arg-type]
        )
