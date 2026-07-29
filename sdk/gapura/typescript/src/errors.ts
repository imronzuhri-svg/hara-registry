import type { Problem } from './types.js';

/**
 * Error thrown when the Gateway returns an RFC 9457 `application/problem+json`
 * response. Carries the parsed problem fields plus the HTTP status.
 */
export class ProblemError extends Error {
  /** URI reference identifying the problem type. */
  readonly type?: string;
  /** Short, human-readable summary. */
  readonly title?: string;
  /** HTTP status code. */
  readonly status?: number;
  /** Stable machine code, e.g. `invalid_digest`, `forbidden_scope`. */
  readonly code?: string;
  /** Human-readable explanation specific to this occurrence. */
  readonly detail?: string;
  /** URI reference identifying the specific occurrence. */
  readonly instance?: string;
  /** Gateway trace id for support/correlation. */
  readonly traceId?: string;
  /** The raw parsed problem body. */
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.detail ?? problem.title ?? problem.code ?? 'Gapura request failed');
    this.name = 'ProblemError';
    this.type = problem.type;
    this.title = problem.title;
    this.status = problem.status;
    this.code = problem.code;
    this.detail = problem.detail;
    this.instance = problem.instance;
    this.traceId = problem.traceId;
    this.problem = problem;
    Object.setPrototypeOf(this, ProblemError.prototype);
  }
}

/** Type guard: is this value a {@link ProblemError}? */
export function isProblem(value: unknown): value is ProblemError {
  return value instanceof ProblemError;
}
