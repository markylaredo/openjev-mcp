/**
 * The tool surface.
 *
 * Five tools: one faithful to the API shape (`jev_ask`), three ergonomic
 * single-judgment tools built on the same path, and `jev_batch`, which puts one
 * set of questions to many states. The first four share one execution routine,
 * so validation, error mapping, and output shaping cannot drift apart; the
 * batch shares the same validation and error mapping.
 *
 * Descriptions here are the agent's documentation. They say what each primitive
 * means, because choosing the right primitive is the caller's job, and they
 * state the one thing that most often misleads an integrator: `confidence`
 * summarises the distribution, it is not the probability of being correct.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { CallToolResult, ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';

import {
  DEFAULT_BATCH_CONCURRENCY,
  MAX_BATCH_ITEMS,
  prepareBatch,
  runBatch,
  summarizeBatch,
  type BatchProgress,
  type BatchSettings,
} from './batch.js';
import { describeDetails, OpenJevClient } from './client.js';
import { isOpenJevError, OpenJevError } from './errors.js';
import { formatIssues, prepareRequest, type PreparedRequest, type RawQuestion } from './questions.js';
import {
  answerSchema,
  batchItemSchema,
  choiceCriteriaSchema,
  hintsSchema,
  instructionsSchema,
  itemErrorSchema,
  modelOutSchema,
  modelSchema,
  noulCriteriaSchema,
  questionIdSchema,
  questionSchema,
  scoreCriteriaSchema,
  stateSchema,
  usageOutSchema,
} from './schemas.js';
import type { Answer, SystemOneRequest, SystemOneResponse } from './types.js';

export interface ToolDependencies {
  client: OpenJevClient;
  batch?: BatchSettings | undefined;
}

/* -------------------------------------------------------------------------- */
/* Execution                                                                  */
/* -------------------------------------------------------------------------- */

/** Per-code advice appended to an error so the caller knows the next move. */
function nextStep(error: OpenJevError): string {
  switch (error.code) {
    case 'auth':
      return 'Next step: check OPENJEV_API_KEY in the MCP server environment; do not retry until it is fixed.';
    case 'invalid_request':
      return 'Next step: fix the request; repeating it unchanged will be rejected the same way.';
    case 'rate_limited':
      return 'Next step: reduce concurrency, or wait out the interval before retrying.';
    case 'unavailable':
      return 'Next step: retry shortly; if it persists, check https://openjev.sh.';
    case 'timeout':
      return 'Next step: raise OPENJEV_TIMEOUT_MS, or send a smaller `state`.';
    case 'network':
      return 'Next step: check network access and OPENJEV_BASE_URL.';
    case 'malformed_response':
      return 'Next step: the response did not match the documented contract; treat the judgment as unavailable rather than guessing.';
    case 'aborted':
      return 'Next step: nothing to do; the call was cancelled.';
    case 'missing_api_key':
      return 'Next step: set OPENJEV_API_KEY in the MCP server environment.';
  }
}

function errorResult(error: unknown, lead = 'OpenJEV call failed'): CallToolResult {
  if (isOpenJevError(error)) {
    const payload: Record<string, unknown> = { code: error.code, retryable: error.retryable };
    if (error.status !== undefined) payload['status'] = error.status;
    if (error.retryAfterMs !== undefined) payload['retry_after_ms'] = error.retryAfterMs;
    const details = describeDetails(error);
    if (details !== undefined) payload['details'] = details;
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `${lead}: ${error.describe()}\n${nextStep(error)}\n${JSON.stringify(payload)}`,
        },
      ],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: 'text', text: `openjev-mcp failed unexpectedly [internal_error]: ${message}` }],
  };
}

function successResult(structured: Record<string, unknown>): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/**
 * Validate, call, and shape one request.
 *
 * `shape` turns a validated response into the tool's structured output; it runs
 * inside the same error boundary as the call, so a missing or unexpected answer
 * becomes a tool error rather than a protocol failure.
 */
async function execute(
  client: OpenJevClient,
  prepared: PreparedRequest,
  model: string | undefined,
  signal: AbortSignal | undefined,
  shape: (response: SystemOneResponse) => Record<string, unknown>,
): Promise<CallToolResult> {
  if (prepared.review.issues.length > 0) {
    return { isError: true, content: [{ type: 'text', text: formatIssues(prepared.review.issues) }] };
  }

  const request: SystemOneRequest = { state: prepared.state, questions: prepared.questions };
  if (model !== undefined) request.model = model;

  try {
    const response = await client.systemOne(request, { signal });
    const structured = shape(response);
    if (prepared.review.hints.length > 0) structured['hints'] = prepared.review.hints;
    return successResult(structured);
  } catch (error) {
    return errorResult(error);
  }
}

function answerFor(response: SystemOneResponse, questionId: string): Answer {
  const answer = Object.hasOwn(response.answers, questionId) ? response.answers[questionId] : undefined;
  if (answer === undefined) {
    throw new OpenJevError({
      code: 'malformed_response',
      message: `OpenJEV returned no answer for question "${questionId}".`,
      details: { answered: Object.keys(response.answers) },
    });
  }
  return answer;
}

function withEnvelope(
  questionId: string,
  answer: Answer,
  response: SystemOneResponse,
): Record<string, unknown> {
  const structured: Record<string, unknown> = { question_id: questionId, answer };
  if (response.model !== undefined) structured['model'] = response.model;
  if (response.usage !== undefined) structured['usage'] = response.usage;
  return structured;
}

/** Ask one single-question judgment through the shared path. */
async function askOne(
  client: OpenJevClient,
  state: unknown,
  questionId: string,
  question: RawQuestion,
  model: string | undefined,
  signal: AbortSignal | undefined,
): Promise<CallToolResult> {
  const prepared = prepareRequest(state, { [questionId]: question });
  return execute(client, prepared, model, signal, response =>
    withEnvelope(questionId, answerFor(response, questionId), response),
  );
}

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;

/** Report batch progress, when the caller asked for it with a progress token. */
function progressReporter(extra: ToolExtra): ((progress: BatchProgress) => void) | undefined {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return undefined;
  return ({ done, total, answered, failed }) => {
    // Advisory: a notification that cannot be delivered must not fail the batch.
    extra
      .sendNotification({
        method: 'notifications/progress',
        params: { progressToken, progress: done, total, message: `${answered} answered, ${failed} failed` },
      })
      .catch(() => undefined);
  };
}

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Every tool asks an external service for a judgment and changes nothing, so the
 * hints are the same for all five. Each one is explicit: directories such as
 * OpenAI's reject a tool that leaves any hint unset.
 */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

export function registerTools(server: McpServer, deps: ToolDependencies): void {
  const { client, batch = {} } = deps;

  server.registerTool(
    'jev_ask',
    {
      title: 'Ask Jev (several questions)',
      description: [
        'Send one shared context and one or more independent questions to Jev (TypeSafe System One) and get typed judgments back — not prose.',
        '',
        'How to design the call:',
        '- `state` carries the text and facts; `instructions` carries the judgment, in the question\'s own words.',
        '- Every question is answered independently against the same state. Order is not a sequence, and no question can use another\'s answer. Ask independent questions together in one call, including conditional ones whose answers you may ignore; make a second call only when an answer decides what to fetch or ask next.',
        '- One call judges one state as a whole. Packing several records into it, such as a list of tickets, yields one blended answer; use `jev_batch` to get an answer per record.',
        '- Prefer `choice` for a category, `score` for an ordered scale, and `noul` for a yes/no judgment. Use separate noul questions when several labels can apply at once, since a choice returns exactly one option.',
        '',
        'Reading the result: answers come back under `answers` keyed by question id. Choice and score carry `probabilities` and `confidence`; `confidence` says how concentrated the distribution is, not how likely the answer is to be correct, so calibrate any threshold on your own labeled examples. Noul carries a single probability — near 1 yes, near 0 no, near 0.5 uncertain — and no confidence field.',
      ].join('\n'),
      inputSchema: {
        state: stateSchema,
        questions: z
          .record(z.string(), questionSchema)
          .describe('Question id to question definition. Non-empty. Ids label the answers for your code.'),
        model: modelSchema,
      },
      outputSchema: {
        answers: z.record(z.string(), answerSchema).describe('One typed answer per requested question id.'),
        model: modelOutSchema,
        usage: usageOutSchema,
        hints: hintsSchema,
      },
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      const prepared = prepareRequest(args.state, args.questions as Record<string, RawQuestion>);
      return execute(client, prepared, args.model, extra.signal, response => {
        const structured: Record<string, unknown> = { answers: response.answers };
        if (response.model !== undefined) structured['model'] = response.model;
        if (response.usage !== undefined) structured['usage'] = response.usage;
        return structured;
      });
    },
  );

  server.registerTool(
    'jev_choice',
    {
      title: 'Jev choice',
      description: [
        'Ask one question whose answer is exactly one of a set of options you define.',
        '',
        'Use for a category, a route, or a selection from a closed list — not for a degree and not for a yes/no. Write the judgment in `instructions`, and put the boundaries in the option descriptions: what each option covers and excludes. Include an option named "other" or "none" when the list may not cover every input. A choice returns exactly one option, so ask separate noul questions (together in `jev_ask`) when several labels can apply at once.',
        '',
        'Returns the selected option, the full probability distribution, and `confidence`. Confidence summarises how concentrated the distribution is — it is not the probability that the selection is correct. Compare it against a threshold you calibrated on your own examples, and send anything below it to a person instead of acting on it.',
      ].join('\n'),
      inputSchema: {
        state: stateSchema,
        instructions: instructionsSchema,
        criteria: choiceCriteriaSchema,
        question_id: questionIdSchema,
        model: modelSchema,
      },
      outputSchema: {
        question_id: z.string(),
        answer: answerSchema,
        model: modelOutSchema,
        usage: usageOutSchema,
        hints: hintsSchema,
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      askOne(
        client,
        args.state,
        args.question_id ?? 'choice',
        { type: 'choice', instructions: args.instructions, criteria: args.criteria },
        args.model,
        extra.signal,
      ),
  );

  server.registerTool(
    'jev_score',
    {
      title: 'Jev score',
      description: [
        'Ask one question whose answer is a position on an ordered scale you define.',
        '',
        'Use for degree, severity, or intensity. `criteria` lists the levels from lowest to highest; a three-level scale returns a score from 0 to 2, and values between integers are positions between levels — the score is the probability-weighted mean of level numbers, not a percentage or a category id. Give every level a self-contained description ("no deadline expressed", "wants a response soon", "explicit deadline"), never a relative one like "more urgent than the level below".',
        '',
        'Returns the score, the `legend` mapping level numbers to their descriptions, the full distribution, and `confidence`. Two different distributions can produce the same score, so read `probabilities` when the difference matters — all weight on level 1 and an even split between 0 and 2 both average to 1.',
      ].join('\n'),
      inputSchema: {
        state: stateSchema,
        instructions: instructionsSchema,
        criteria: scoreCriteriaSchema,
        question_id: questionIdSchema,
        model: modelSchema,
      },
      outputSchema: {
        question_id: z.string(),
        answer: answerSchema,
        model: modelOutSchema,
        usage: usageOutSchema,
        hints: hintsSchema,
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      askOne(
        client,
        args.state,
        args.question_id ?? 'score',
        { type: 'score', instructions: args.instructions, criteria: args.criteria },
        args.model,
        extra.signal,
      ),
  );

  server.registerTool(
    'jev_noul',
    {
      title: 'Jev noul',
      description: [
        'Ask one yes/no question and get its probability.',
        '',
        'Use when the condition either holds or does not, and the probability is more useful than a category. Name the condition precisely in `instructions`; optionally describe the two outcomes in `criteria.true` and `criteria.false`, or omit `criteria` when the instructions already define both.',
        '',
        'Returns a value between 0 and 1: near 1 yes, near 0 no, near 0.5 uncertain. It measures probability, not intensity, and there is no separate confidence field — a confident no is near 0, not near 0.5, so read low values as evidence against rather than as low confidence.',
      ].join('\n'),
      inputSchema: {
        state: stateSchema,
        instructions: instructionsSchema,
        criteria: noulCriteriaSchema.optional(),
        question_id: questionIdSchema,
        model: modelSchema,
      },
      outputSchema: {
        question_id: z.string(),
        answer: answerSchema,
        model: modelOutSchema,
        usage: usageOutSchema,
        hints: hintsSchema,
      },
      annotations: READ_ONLY,
    },
    async (args, extra) =>
      askOne(
        client,
        args.state,
        args.question_id ?? 'noul',
        { type: 'noul', instructions: args.instructions, criteria: args.criteria },
        args.model,
        extra.signal,
      ),
  );

  server.registerTool(
    'jev_batch',
    {
      title: 'Jev batch (many items)',
      description: [
        'Put the same independent questions to each of many items — a queue of tickets, a page of comments, rows of records — and get typed answers per item.',
        '',
        'How it runs: each item is its own request to Jev, carrying its state and every question, so an item costs what a `jev_ask` call with those questions costs. Requests go out a few at a time and are paced to the key\'s rate limit. Use `jev_ask` for a single item.',
        '',
        'How to design the call:',
        `- \`items\` holds 1 to ${MAX_BATCH_ITEMS} records, each with its own \`state\`. Give every item an \`id\` — the record's own id, such as a ticket number — so its results map back without counting positions; without ids, items are labelled by position from "0".`,
        '- `questions` follows the same rules as in `jev_ask`, and every item is judged against all of them, independently.',
        '',
        'Reading the result: `counts` gives the totals. `answers[item id][question id]` holds an answered item\'s answers, shaped as in `jev_ask`; `confidence` says how concentrated a distribution is, not how likely the answer is to be correct. `errors[item id]` holds an item that failed, with its `code` and whether it is `retryable`. When the call ends early — a rejected key, a rate limit it cannot wait out, several failures in a row, or its time budget — `stopped` says why and `not_sent` lists the items never sent. Send those, and any retryable errors, in a later call, after `retry_after_ms` when it is given.',
      ].join('\n'),
      inputSchema: {
        items: z
          .array(batchItemSchema)
          .min(1)
          .max(MAX_BATCH_ITEMS)
          .describe(`The records to judge, 1 to ${MAX_BATCH_ITEMS} per call. Each is sent as its own request, with every question.`),
        questions: z
          .record(z.string(), questionSchema)
          .describe('Question id to question definition, as in `jev_ask`. Non-empty. Every item is asked every question.'),
        model: modelSchema,
      },
      outputSchema: {
        counts: z
          .object({ total: z.number(), answered: z.number(), failed: z.number(), not_sent: z.number() })
          .describe('How many items were answered, failed, or never sent.'),
        stopped: z
          .object({
            code: z.string(),
            message: z.string(),
            retryable: z.boolean(),
            retry_after_ms: z.number().optional(),
          })
          .optional()
          .describe('Present when the call ended before sending every item: why, and whether the unsent items can be sent again as they are.'),
        answers: z
          .record(z.string(), z.record(z.string(), answerSchema))
          .describe('Item id to that item\'s answers, keyed by question id as in `jev_ask`.'),
        errors: z
          .record(z.string(), itemErrorSchema)
          .optional()
          .describe('Item id to the failure of an item that was sent but not answered.'),
        not_sent: z.array(z.string()).optional().describe('Ids of the items never sent because the call stopped early.'),
        model: modelOutSchema,
        usage: usageOutSchema.describe('Tokens summed over the answered items.'),
        hints: hintsSchema,
      },
      annotations: READ_ONLY,
    },
    async (args, extra) => {
      const prepared = prepareBatch(args.items, args.questions as Record<string, RawQuestion>);
      if (prepared.review.issues.length > 0) {
        return { isError: true, content: [{ type: 'text', text: formatIssues(prepared.review.issues) }] };
      }
      try {
        const result = await runBatch(client, prepared, {
          concurrency: batch.concurrency ?? DEFAULT_BATCH_CONCURRENCY,
          timeBudgetMs: batch.timeBudgetMs ?? client.callBudgetMs,
          model: args.model,
          signal: extra.signal,
          onProgress: progressReporter(extra),
          sleepImpl: batch.sleepImpl,
        });
        const summary = summarizeBatch(result, prepared.review.hints);
        if (!summary.ok) return errorResult(summary.error, summary.lead);
        // Compact: a batch result runs long, and indentation would cost the
        // caller tokens on every item.
        return { content: [{ type: 'text', text: JSON.stringify(summary.structured) }], structuredContent: summary.structured };
      } catch (error) {
        return errorResult(error);
      }
    },
  );
}
