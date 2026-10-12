/**
 * `jev_batch`: the same questions, put to many items.
 *
 * OpenJEV judges one state per request, so a batch is one request per item. It
 * saves the agent a loop, not a call. What it adds is the part a loop gets
 * wrong: requests go out a few at a time; a 429 pauses new requests for as long
 * as the service asked and halves the concurrency, as the OpenJEV docs direct;
 * the batch stops early, keeping every answer it has, when going on would only
 * spend calls on a failure that repeats; and the whole call is bounded by the
 * same time budget as a single call, so a client timeout that covers one call
 * covers a batch.
 */

import { setTimeout as delay } from 'node:timers/promises';

import { describeDetails, type CallOptions } from './client.js';
import { OpenJevError } from './errors.js';
import { prepareQuestions, reviewState, type RawQuestion, type Review } from './questions.js';
import type { Answer, Question, State, SystemOneRequest, SystemOneResponse, Usage } from './types.js';

/** Items per call. Our cap, not the API's: it keeps one result readable. */
export const MAX_BATCH_ITEMS = 100;

/** Requests in flight at once when `OPENJEV_BATCH_CONCURRENCY` is unset. */
export const DEFAULT_BATCH_CONCURRENCY = 4;

/** Items failing in a row after which the rest of a batch is not sent. */
export const STOP_AFTER_FAILURES = 3;

/** Longest server detail carried on one item's error; a batch may hold many. */
const ITEM_DETAIL_CHARS = 300;

/** How `jev_batch` runs, fixed for the life of the server. */
export interface BatchSettings {
  /** Requests in flight at once, per call. Defaults to 4. */
  concurrency?: number | undefined;
  /** Bound on one call. Defaults to the client's single-call worst case. */
  timeBudgetMs?: number | undefined;
  /** Sleep seam for tests. Defaults to a real timer. */
  sleepImpl?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

/** An item as it arrives from a tool argument. */
export interface RawBatchItem {
  id?: string | number | undefined;
  state: unknown;
}

export interface BatchItem {
  /** The caller's label for the item, or its position when items carry none. */
  id: string;
  state: State;
}

export interface PreparedBatch {
  items: BatchItem[];
  questions: Record<string, Question>;
  review: Review;
}

/** What became of one item that was sent. */
export type ItemOutcome = { response: SystemOneResponse } | { error: OpenJevError };

export interface BatchStop {
  /** Why the remaining items were not sent, and what to do about them. */
  reason: string;
  /** The failure behind the stop; its code and retryability apply to the unsent items. */
  error: OpenJevError;
}

export interface BatchResult {
  items: BatchItem[];
  /** One entry per item, in input order; `undefined` for an item that was never sent. */
  outcomes: Array<ItemOutcome | undefined>;
  /** Set when the batch ended before every item was sent. */
  stop: BatchStop | undefined;
}

export interface BatchProgress {
  done: number;
  total: number;
  answered: number;
  failed: number;
}

/** The part of `OpenJevClient` a batch uses. */
export interface BatchClient {
  systemOne(request: SystemOneRequest, options?: CallOptions): Promise<SystemOneResponse>;
}

export interface BatchRunOptions {
  /** Requests in flight at once, until a 429 lowers it. */
  concurrency: number;
  /** At this deadline, items in flight are cancelled and the rest are not sent. */
  timeBudgetMs: number;
  model?: string | undefined;
  signal?: AbortSignal | undefined;
  /** Called after each item is answered or fails. */
  onProgress?: ((progress: BatchProgress) => void) | undefined;
  sleepImpl?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
}

/**
 * Check a whole batch before anything is sent: the item count, every state,
 * the ids, and the questions every item shares. One problem anywhere rejects
 * the batch, as it would a single call; a batch that quietly skipped a bad item
 * would look complete.
 */
export function prepareBatch(rawItems: RawBatchItem[], rawQuestions: Record<string, RawQuestion>): PreparedBatch {
  const review: Review = { issues: [], hints: [] };
  const items: BatchItem[] = [];

  if (rawItems.length === 0) {
    review.issues.push({ path: 'items', message: 'needs at least one item' });
  } else if (rawItems.length > MAX_BATCH_ITEMS) {
    review.issues.push({
      path: 'items',
      message: `allows at most ${MAX_BATCH_ITEMS} items per call; got ${rawItems.length}. Send the rest in further calls.`,
    });
  } else {
    // Mixing labelled and positional items would let an id like "3" collide
    // with the fourth item's position, so ids are all or nothing.
    const labelled = rawItems.some(item => item.id !== undefined);
    const seen = new Map<string, number>();
    rawItems.forEach((raw, index) => {
      const path = `items[${index}]`;
      reviewState(raw.state, review.issues, `${path}.state`);
      const id = raw.id === undefined ? String(index) : String(raw.id);
      const earlier = seen.get(id);
      if (labelled && raw.id === undefined) {
        review.issues.push({ path: `${path}.id`, message: 'is missing; when any item has an id, every item needs one' });
      } else if (id.trim().length === 0) {
        review.issues.push({ path: `${path}.id`, message: 'must not be empty' });
      } else if (earlier !== undefined) {
        review.issues.push({
          path: `${path}.id`,
          message: `"${id}" is also the id of items[${earlier}]; ids label the results, so each must be unique`,
        });
      } else {
        seen.set(id, index);
      }
      items.push({ id, state: raw.state as State });
    });
  }

  const questions = prepareQuestions(rawQuestions, review);
  return { items, questions, review };
}

function formatDuration(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/**
 * Send every item, a few at a time, and record what became of each.
 *
 * Failures are recorded per item rather than thrown. A failure that would
 * repeat for every remaining item — a rejected key, a rate limit this call
 * cannot wait out, several items failing in a row — ends the batch with a
 * `stop`, as do the caller's cancellation and the time budget.
 */
export async function runBatch(
  client: BatchClient,
  batch: Pick<PreparedBatch, 'items' | 'questions'>,
  options: BatchRunOptions,
): Promise<BatchResult> {
  const { items, questions } = batch;
  const sleep = options.sleepImpl ?? ((ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }));
  const outcomes: Array<ItemOutcome | undefined> = items.map(() => undefined);
  const budget = formatDuration(options.timeBudgetMs);

  // One controller cancels everything in flight, whether the caller cancelled
  // or the time budget ran out.
  const controller = new AbortController();
  let stop: BatchStop | undefined;
  let budgetSpent = false;
  let unexpected: { error: unknown } | undefined;
  const halt = (next: BatchStop): void => {
    stop ??= next;
  };

  const callerSignal = options.signal;
  const onCallerAbort = (): void => {
    halt({
      reason: 'The call was cancelled, so the remaining items were not sent.',
      error: new OpenJevError({ code: 'aborted', message: 'The request was cancelled before it completed.' }),
    });
    controller.abort();
  };
  if (callerSignal?.aborted) onCallerAbort();
  else callerSignal?.addEventListener('abort', onCallerAbort, { once: true });

  const budgetTimer = setTimeout(() => {
    budgetSpent = true;
    halt({
      reason: `The call reached its ${budget} time budget: items still in flight were cancelled and the rest were not sent. Send the unanswered items in another call.`,
      error: new OpenJevError({ code: 'timeout', message: `jev_batch reached its ${budget} time budget.` }),
    });
    controller.abort();
  }, options.timeBudgetMs);

  let limit = Math.max(1, Math.min(Math.floor(options.concurrency), items.length));
  let pausedUntil = 0;
  let cursor = 0;
  let answered = 0;
  let failed = 0;
  let failuresInARow = 0;

  // A 429 on any request is the key's limit, so it holds back every request:
  // nothing new is sent until the wait it asked for is over, and concurrency is
  // halved, once per wait, since the other requests' 429s in that interval are
  // the same signal arriving again.
  const onRetry = (failure: OpenJevError, delayMs: number): void => {
    if (failure.code !== 'rate_limited') return;
    const now = Date.now();
    if (now >= pausedUntil) limit = Math.max(1, Math.floor(limit / 2));
    pausedUntil = Math.max(pausedUntil, now + delayMs);
  };

  const running = (): boolean => stop === undefined && !controller.signal.aborted;

  async function waitWhilePaused(): Promise<void> {
    let until = pausedUntil;
    for (;;) {
      const wait = until - Date.now();
      if (wait > 0) await sleep(wait, controller.signal);
      // A 429 that arrives during the wait extends it.
      if (pausedUntil <= until) return;
      until = pausedUntil;
    }
  }

  function noteFailure(error: OpenJevError): void {
    if (error.code === 'auth') {
      halt({
        reason: 'OpenJEV rejected the API key, so the remaining items were not sent. Fix OPENJEV_API_KEY in the MCP server environment before sending them.',
        error,
      });
      return;
    }
    if (error.code === 'rate_limited') {
      halt({
        reason: `OpenJEV rate limited this key beyond what one call waits out, so the remaining items were not sent. Send them after ${
          error.retryAfterMs === undefined ? 'a pause' : 'retry_after_ms'
        }.`,
        error,
      });
      return;
    }
    failuresInARow += 1;
    if (failuresInARow >= STOP_AFTER_FAILURES) {
      halt({
        reason: `${failuresInARow} items in a row failed, so the remaining items were not sent rather than spend calls on a failure that repeats. Last failure: ${error.describe()}`,
        error,
      });
    }
  }

  async function send(index: number): Promise<void> {
    const request: SystemOneRequest = { state: items[index]!.state, questions };
    if (options.model !== undefined) request.model = options.model;
    try {
      const response = await client.systemOne(request, { signal: controller.signal, onRetry });
      outcomes[index] = { response };
      answered += 1;
      failuresInARow = 0;
    } catch (error) {
      if (!(error instanceof OpenJevError)) {
        // A bug, not a service failure: cancel the rest and report it as one.
        unexpected ??= { error };
        controller.abort();
        return;
      }
      failed += 1;
      if (error.code === 'aborted') {
        // Cancelled in flight; the stop that cancelled it is already recorded.
        outcomes[index] = {
          error: budgetSpent
            ? new OpenJevError({
                code: 'timeout',
                message: `Cancelled at the ${budget} time budget of the batch, before an answer arrived.`,
              })
            : error,
        };
      } else {
        outcomes[index] = { error };
        noteFailure(error);
      }
    }
    try {
      options.onProgress?.({ done: answered + failed, total: items.length, answered, failed });
    } catch {
      // Progress is advisory; reporting it must never end the batch.
    }
  }

  async function worker(slot: number): Promise<void> {
    while (running() && slot < limit && cursor < items.length) {
      try {
        await waitWhilePaused();
      } catch {
        return; // cancelled during the pause
      }
      if (!running() || slot >= limit || cursor >= items.length) return;
      const index = cursor;
      cursor += 1;
      await send(index);
    }
  }

  try {
    await Promise.all(Array.from({ length: limit }, (_, slot) => worker(slot)));
  } finally {
    clearTimeout(budgetTimer);
    callerSignal?.removeEventListener('abort', onCallerAbort);
  }
  if (unexpected !== undefined) throw unexpected.error;
  return { items, outcomes, stop };
}

/**
 * The tool's view of a finished batch: a structured result when anything was
 * answered, or the failure to report when nothing was.
 */
export type BatchSummary =
  | { ok: true; structured: Record<string, unknown> }
  | { ok: false; error: OpenJevError; lead: string };

function itemError(error: OpenJevError): Record<string, unknown> {
  const payload: Record<string, unknown> = { code: error.code, message: error.message, retryable: error.retryable };
  if (error.status !== undefined) payload['status'] = error.status;
  if (error.retryAfterMs !== undefined) payload['retry_after_ms'] = error.retryAfterMs;
  const details = describeDetails(error);
  if (details !== undefined) {
    payload['details'] = details.length > ITEM_DETAIL_CHARS ? `${details.slice(0, ITEM_DETAIL_CHARS)}…` : details;
  }
  return payload;
}

function addUsage(total: Usage, usage: Usage | undefined): void {
  if (usage?.input_tokens !== undefined) total.input_tokens = (total.input_tokens ?? 0) + usage.input_tokens;
  if (usage?.output_tokens !== undefined) total.output_tokens = (total.output_tokens ?? 0) + usage.output_tokens;
}

/** Key answers and errors by item id, and say what was left unsent and why. */
export function summarizeBatch(result: BatchResult, hints: string[]): BatchSummary {
  const answers: Array<[string, Record<string, Answer>]> = [];
  const errors: Array<[string, OpenJevError]> = [];
  const notSent: string[] = [];
  const models = new Set<string>();
  const usage: Usage = {};
  result.items.forEach((item, index) => {
    const outcome = result.outcomes[index];
    if (outcome === undefined) {
      notSent.push(item.id);
    } else if ('response' in outcome) {
      answers.push([item.id, outcome.response.answers]);
      if (outcome.response.model !== undefined) models.add(outcome.response.model);
      addUsage(usage, outcome.response.usage);
    } else {
      errors.push([item.id, outcome.error]);
    }
  });

  const total = result.items.length;
  if (answers.length === 0) {
    const cause = result.stop?.error ?? errors[0]?.[1];
    if (cause === undefined) throw new Error('jev_batch finished with no answer, failure, or stop to report.');
    const tally = notSent.length === 0 ? `${errors.length} failed` : `${errors.length} failed, ${notSent.length} not sent`;
    return { ok: false, error: cause, lead: `OpenJEV batch answered none of its ${total} items (${tally})` };
  }

  // Defined as own properties, so an item id such as `__proto__` stays a label.
  const structured: Record<string, unknown> = {
    counts: { total, answered: answers.length, failed: errors.length, not_sent: notSent.length },
  };
  if (result.stop !== undefined) {
    const stopped: Record<string, unknown> = {
      code: result.stop.error.code,
      message: result.stop.reason,
      retryable: result.stop.error.retryable,
    };
    if (result.stop.error.retryAfterMs !== undefined) stopped['retry_after_ms'] = result.stop.error.retryAfterMs;
    structured['stopped'] = stopped;
  }
  structured['answers'] = Object.fromEntries(answers);
  if (errors.length > 0) structured['errors'] = Object.fromEntries(errors.map(([id, error]) => [id, itemError(error)]));
  if (notSent.length > 0) structured['not_sent'] = notSent;
  const [model, ...others] = models;
  if (model !== undefined && others.length === 0) structured['model'] = model;
  if (Object.keys(usage).length > 0) structured['usage'] = usage;
  const allHints =
    others.length === 0
      ? hints
      : [...hints, `Items were answered by different models (${[...models].join(', ')}); compare their answers with care.`];
  if (allHints.length > 0) structured['hints'] = allHints;
  return { ok: true, structured };
}
