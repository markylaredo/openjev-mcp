/**
 * HTTP client for the OpenJEV System One endpoint.
 *
 * One POST carries a `state` and a map of independent questions; the response
 * carries one typed answer per question. The client owns transport concerns
 * only: authentication, timeouts, bounded retries for the statuses OpenJEV
 * documents as retryable, a precise error taxonomy, and response validation.
 * It deliberately holds no thresholds — those belong to the application.
 */

import { OpenJevError } from './errors.js';
import type {
  Answer,
  CriterionDescription,
  SystemOneRequest,
  SystemOneResponse,
  Usage,
} from './types.js';
import { VERSION } from './version.js';

export const DEFAULT_BASE_URL = 'https://api.openjev.sh';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
export const DEFAULT_RETRY_BASE_DELAY_MS = 500;
/**
 * Longest `Retry-After` we are willing to sleep through. A longer one is
 * surfaced to the caller instead of stalling the tool call indefinitely.
 */
export const DEFAULT_MAX_RETRY_AFTER_MS = 15_000;

const MAX_BACKOFF_MS = 8_000;
const DETAIL_EXCERPT_CHARS = 2_000;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface OpenJevClientOptions {
  apiKey: string;
  /** Origin of the API. Defaults to `https://api.openjev.sh`. */
  baseUrl?: string | undefined;
  /** Per-attempt timeout. Defaults to 30000 ms. */
  timeoutMs?: number | undefined;
  /** Retries after the first attempt. Defaults to 2. */
  maxRetries?: number | undefined;
  /** Base for exponential backoff. Defaults to 500 ms. */
  retryBaseDelayMs?: number | undefined;
  /** Cap on an honored `Retry-After`. Defaults to 15000 ms. */
  maxRetryAfterMs?: number | undefined;
  /** Model alias sent when a request does not name one. Omitted by default. */
  defaultModel?: string | undefined;
  /** Transport seam for tests. Defaults to global `fetch`. */
  fetchImpl?: FetchLike | undefined;
  /** Sleep seam for tests. Defaults to a real timer. */
  sleepImpl?: ((ms: number) => Promise<void>) | undefined;
  userAgent?: string | undefined;
}

export interface CallOptions {
  /** Aborts the call; the caller's reason is preserved as an `aborted` error. */
  signal?: AbortSignal | undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

/** Parse `Retry-After`, which OpenJEV's limiter expresses in seconds. */
export function parseRetryAfter(value: string | null, now: number = Date.now()): number | undefined {
  if (value === null) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.round(Number(trimmed) * 1000));
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** Decode a body as JSON, falling back to a bounded text excerpt. */
function decodeBody(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed.slice(0, DETAIL_EXCERPT_CHARS);
  }
}

function excerpt(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > DETAIL_EXCERPT_CHARS ? `${text.slice(0, DETAIL_EXCERPT_CHARS)}…` : text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isProbability(value: unknown): value is number {
  return isFiniteNumber(value) && value >= -1e-6 && value <= 1 + 1e-6;
}

/**
 * Build a probability map from untrusted keys. `Object.fromEntries` defines own
 * properties, so option names like `__proto__` behave like any other name.
 */
function probabilityMap(
  probabilities: Record<string, unknown>,
  questionId: string,
  value: unknown,
): Record<string, number> {
  const entries: Array<[string, number]> = [];
  for (const [key, probability] of Object.entries(probabilities)) {
    if (!isProbability(probability)) {
      throw malformed(
        `OpenJEV returned a non-numeric probability for option "${key}" of question "${questionId}".`,
        value,
      );
    }
    entries.push([key, probability]);
  }
  return Object.fromEntries(entries);
}

function malformed(message: string, details?: unknown): OpenJevError {
  return new OpenJevError({
    code: 'malformed_response',
    message,
    ...(details === undefined ? {} : { details }),
  });
}

function parseAnswer(questionId: string, value: unknown): Answer {
  if (!isPlainObject(value)) {
    throw malformed(
      `OpenJEV returned a ${value === null ? 'null' : typeof value} answer for question "${questionId}"; expected an object.`,
    );
  }

  const declared = value['type'];
  let kind: string | undefined;
  if (typeof declared === 'string') {
    if (declared !== 'choice' && declared !== 'score' && declared !== 'noul') {
      throw malformed(`OpenJEV returned an unknown answer type "${declared}" for question "${questionId}".`, value);
    }
    kind = declared;
  } else if (isProbability(value['noul'])) {
    kind = 'noul';
  } else if (typeof value['choice'] === 'string') {
    kind = 'choice';
  } else if (isFiniteNumber(value['score'])) {
    kind = 'score';
  }

  if (kind === undefined) {
    throw malformed(`OpenJEV returned an answer for question "${questionId}" with no recognisable type.`, value);
  }

  if (kind === 'noul') {
    const noul = value['noul'];
    if (!isProbability(noul)) {
      throw malformed(
        `OpenJEV returned a noul answer for question "${questionId}" without a probability between 0 and 1.`,
        value,
      );
    }
    return { type: 'noul', noul };
  }

  const probabilities = value['probabilities'];
  if (!isPlainObject(probabilities)) {
    throw malformed(
      `OpenJEV returned a ${kind} answer for question "${questionId}" without a probabilities object.`,
      value,
    );
  }
  const parsedProbabilities = probabilityMap(probabilities, questionId, value);
  const confidence = value['confidence'];
  if (!isProbability(confidence)) {
    throw malformed(
      `OpenJEV returned a ${kind} answer for question "${questionId}" without a confidence between 0 and 1.`,
      value,
    );
  }

  if (kind === 'choice') {
    const choice = value['choice'];
    if (typeof choice !== 'string') {
      throw malformed(`OpenJEV returned a choice answer for question "${questionId}" without a selected option.`, value);
    }
    return { type: 'choice', choice, probabilities: parsedProbabilities, confidence };
  }

  const score = value['score'];
  if (!isFiniteNumber(score)) {
    throw malformed(`OpenJEV returned a score answer for question "${questionId}" without a numeric score.`, value);
  }
  const legend = value['legend'];
  const parsedLegend: Record<string, CriterionDescription> = isPlainObject(legend)
    ? (Object.fromEntries(Object.entries(legend)) as Record<string, CriterionDescription>)
    : {};
  return { type: 'score', score, legend: parsedLegend, probabilities: parsedProbabilities, confidence };
}

function parseUsage(value: unknown): Usage | undefined {
  if (!isPlainObject(value)) return undefined;
  const usage: Usage = {};
  if (isFiniteNumber(value['input_tokens'])) usage.input_tokens = value['input_tokens'];
  if (isFiniteNumber(value['output_tokens'])) usage.output_tokens = value['output_tokens'];
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Validate a 2xx body against the documented response contract. */
export function parseSystemOneResponse(raw: string): SystemOneResponse {
  const decoded = decodeBody(raw);
  if (!isPlainObject(decoded)) {
    throw malformed('OpenJEV returned a response body that is not a JSON object.', excerpt(decoded));
  }
  const answers = decoded['answers'];
  if (!isPlainObject(answers)) {
    throw malformed('OpenJEV returned a response body with no `answers` object.', decoded);
  }
  const parsedAnswers = Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => [questionId, parseAnswer(questionId, value)]),
  ) as Record<string, Answer>;
  const response: SystemOneResponse = { answers: parsedAnswers };
  if (typeof decoded['model'] === 'string') response.model = decoded['model'];
  const usage = parseUsage(decoded['usage']);
  if (usage !== undefined) response.usage = usage;
  return response;
}

/**
 * The contract is one answer per question. A missing answer is not a judgment
 * we can invent, so it is reported as an off-contract response.
 */
function assertEveryQuestionAnswered(request: SystemOneRequest, response: SystemOneResponse): void {
  const unanswered = Object.keys(request.questions).filter(id => !Object.hasOwn(response.answers, id));
  if (unanswered.length > 0) {
    throw malformed(
      `OpenJEV returned no answer for ${unanswered.length === 1 ? 'question' : 'questions'} ${unanswered
        .map(id => `"${id}"`)
        .join(', ')}.`,
      { answered: Object.keys(response.answers) },
    );
  }
}

function httpError(status: number, body: unknown, retryAfterMs: number | undefined): OpenJevError {
  const base = { status, details: body, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
  if (status === 401 || status === 403) {
    return new OpenJevError({
      ...base,
      code: 'auth',
      message: 'OpenJEV rejected the API key. Check OPENJEV_API_KEY: it must be a current key from https://openjev.sh/dashboard.',
    });
  }
  if (status === 422) {
    return new OpenJevError({
      ...base,
      code: 'invalid_request',
      message: 'OpenJEV rejected the request body as invalid. Fix the request before retrying; repeating it will fail the same way.',
    });
  }
  if (status === 429) {
    return new OpenJevError({
      ...base,
      code: 'rate_limited',
      message:
        retryAfterMs === undefined
          ? 'OpenJEV rate limited this key.'
          : `OpenJEV rate limited this key; it asked for a ${Math.ceil(retryAfterMs / 1000)}s wait.`,
    });
  }
  if (status >= 500) {
    return new OpenJevError({
      ...base,
      code: 'unavailable',
      message: 'OpenJEV is temporarily unavailable.',
    });
  }
  return new OpenJevError({
    ...base,
    code: 'invalid_request',
    message: `OpenJEV refused the request with HTTP ${status}.`,
  });
}

export class OpenJevClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly defaultModel: string | undefined;
  private readonly fetchImpl: FetchLike;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly userAgent: string;

  constructor(options: OpenJevClientOptions) {
    if (typeof options.apiKey !== 'string' || options.apiKey.trim().length === 0) {
      throw new OpenJevError({
        code: 'missing_api_key',
        message:
          'OPENJEV_API_KEY is not set. Create a key at https://openjev.sh/dashboard and give the MCP server the environment variable OPENJEV_API_KEY.',
      });
    }
    this.apiKey = options.apiKey.trim();
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL);
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = Math.max(0, options.maxRetries ?? DEFAULT_MAX_RETRIES);
    this.retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS);
    this.maxRetryAfterMs = Math.max(0, options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS);
    this.defaultModel = options.defaultModel;
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
    this.sleepImpl = options.sleepImpl ?? sleep;
    this.userAgent = options.userAgent ?? `openjev-mcp/${VERSION}`;
  }

  /** The origin requests are sent to, after normalization. */
  get endpoint(): string {
    return `${this.baseUrl}/v1/systemone`;
  }

  /**
   * Send one request: a shared `state` and one or more independent questions.
   *
   * Retries the documented transient failures (`429`, `5xx`, timeouts, network
   * errors) with bounded backoff, honoring `Retry-After` when the wait is
   * short enough to be worth taking. Every failure throws `OpenJevError`.
   */
  async systemOne(request: SystemOneRequest, options: CallOptions = {}): Promise<SystemOneResponse> {
    const body: Record<string, unknown> = {};
    const model = request.model ?? this.defaultModel;
    if (model !== undefined) body['model'] = model;
    body['state'] = request.state;
    body['questions'] = request.questions;
    const payload = JSON.stringify(body);

    let attempt = 0;
    for (;;) {
      try {
        const response = await this.attempt(payload, options.signal);
        assertEveryQuestionAnswered(request, response);
        return response;
      } catch (error) {
        const failure = error instanceof OpenJevError ? error : undefined;
        if (failure === undefined) throw error;
        if (!failure.retryable || attempt >= this.maxRetries) throw failure;
        const delay = failure.retryAfterMs ?? this.backoffMs(attempt);
        if (delay > this.maxRetryAfterMs) throw failure;
        await this.sleepImpl(delay);
        attempt += 1;
      }
    }
  }

  private backoffMs(attempt: number): number {
    const base = Math.min(this.retryBaseDelayMs * 2 ** attempt, MAX_BACKOFF_MS);
    return Math.round(base * (0.9 + Math.random() * 0.2));
  }

  private async attempt(payload: string, callerSignal: AbortSignal | undefined): Promise<SystemOneResponse> {
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = (): void => {
      controller.abort(callerSignal?.reason);
    };
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) onCallerAbort();
      else callerSignal.addEventListener('abort', onCallerAbort, { once: true });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, this.timeoutMs);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'User-Agent': this.userAgent,
        },
        body: payload,
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        throw httpError(response.status, decodeBody(raw), parseRetryAfter(response.headers.get('retry-after')));
      }
      return parseSystemOneResponse(raw);
    } catch (error) {
      if (error instanceof OpenJevError) throw error;
      if (timedOut) {
        throw new OpenJevError({
          code: 'timeout',
          message: `OpenJEV did not answer within ${this.timeoutMs} ms.`,
          details: error,
        });
      }
      if (callerSignal?.aborted === true) {
        throw new OpenJevError({ code: 'aborted', message: 'The request was cancelled before it completed.' });
      }
      throw new OpenJevError({
        code: 'network',
        message: `Could not reach ${this.endpoint}. Check network access and OPENJEV_BASE_URL.`,
        details: error instanceof Error ? error.message : error,
      });
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener('abort', onCallerAbort);
    }
  }
}

/** Human-readable detail from an error's `details`, for logs and tool output. */
export function describeDetails(error: OpenJevError): string | undefined {
  if (error.details === undefined) return undefined;
  const text = excerpt(error.details);
  return text.length > 0 ? text : undefined;
}
