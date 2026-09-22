/**
 * Error taxonomy for OpenJEV calls.
 *
 * Every failure that can reach a caller is an `OpenJevError` with a stable
 * `code`, so tool handlers and applications can branch on the failure kind
 * instead of parsing messages. `retryable` states whether the same request may
 * succeed later; it is not a promise that a retry is free.
 */

export type OpenJevErrorCode =
  /** No API key was configured. A local configuration fault. */
  | 'missing_api_key'
  /** HTTP 401/403: the key is missing, wrong, or revoked. Fix credentials first. */
  | 'auth'
  /** HTTP 422 (and other 4xx): the request body was rejected. Retrying changes nothing. */
  | 'invalid_request'
  /** HTTP 429: too many requests. Honor `retryAfterMs`. */
  | 'rate_limited'
  /** HTTP 5xx other than 429: the service failed or is temporarily down. */
  | 'unavailable'
  /** The request exceeded the configured timeout. */
  | 'timeout'
  /** The request never reached OpenJEV, or the connection failed. */
  | 'network'
  /** The caller aborted the request. */
  | 'aborted'
  /** A 2xx response did not match the documented response contract. */
  | 'malformed_response';

export interface OpenJevErrorInit {
  code: OpenJevErrorCode;
  message: string;
  status?: number | undefined;
  retryable?: boolean | undefined;
  retryAfterMs?: number | undefined;
  details?: unknown;
}

/** Codes for which repeating the identical request may plausibly succeed. */
function defaultRetryable(code: OpenJevErrorCode): boolean {
  switch (code) {
    case 'rate_limited':
    case 'unavailable':
    case 'timeout':
    case 'network':
      return true;
    default:
      return false;
  }
}

export class OpenJevError extends Error {
  readonly code: OpenJevErrorCode;
  readonly status: number | undefined;
  readonly retryable: boolean;
  /** Milliseconds the server asked us to wait, when it said so (`Retry-After`). */
  readonly retryAfterMs: number | undefined;
  /** Server-provided diagnostics (a parsed error body, or a text excerpt). */
  readonly details: unknown;

  constructor(init: OpenJevErrorInit) {
    super(init.message);
    this.name = 'OpenJevError';
    this.code = init.code;
    this.status = init.status;
    this.retryable = init.retryable ?? defaultRetryable(init.code);
    this.retryAfterMs = init.retryAfterMs;
    this.details = init.details;
  }

  /** A single-line, agent-facing explanation with a next step. */
  describe(): string {
    const status = this.status === undefined ? '' : ` (HTTP ${this.status})`;
    return `${this.message}${status} [${this.code}]`;
  }
}

export function isOpenJevError(value: unknown): value is OpenJevError {
  return value instanceof OpenJevError;
}
