/**
 * The tool surface.
 *
 * Four tools: one faithful to the API shape (`jev_ask`) and three ergonomic
 * single-judgment tools built on the same path. All four share one execution
 * routine, so validation, error mapping, and output shaping cannot drift apart.
 *
 * Descriptions here are the agent's documentation. They say what each primitive
 * means, because choosing the right primitive is the caller's job, and they
 * state the one thing that most often misleads an integrator: `confidence`
 * summarises the distribution, it is not the probability of being correct.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { describeDetails, OpenJevClient } from './client.js';
import { isOpenJevError, OpenJevError } from './errors.js';
import { formatIssues, prepareRequest, type PreparedRequest, type RawQuestion } from './questions.js';
import type { Answer, SystemOneRequest, SystemOneResponse } from './types.js';

export interface ToolDependencies {
  client: OpenJevClient;
}

/* -------------------------------------------------------------------------- */
/* Schemas                                                                    */
/* -------------------------------------------------------------------------- */

const stateSchema = z
  .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
  .describe(
    'The content the questions are judged against: text, an object of named fields, or an array of records. Reference a nested field from `instructions` with a dotted path in backticks, e.g. `account.plan`. Fetch external records first — a URL here is not a request to browse — and note that this API accepts no image, audio, or file uploads.',
  );

const instructionsSchema = z
  .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
  .describe(
    'The judgment to make, written out in full. A clear specific string is usually enough; use an object or array when the judgment, its scope, and its constraints belong together. The question id is not sent to the model, so never rely on it to carry meaning.',
  );

const questionSchema = z.object({
  type: z.enum(['choice', 'score', 'noul']).describe('choice: one of a set of named options. score: a position on an ordered scale. noul: a yes/no probability.'),
  instructions: instructionsSchema,
  criteria: z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .optional()
    .describe(
      'The possible answers. For choice, an object of option name to description (or an array of option names as shorthand); up to 255 options. For score, an ordered array of levels, lowest first; up to 10. For noul, optional {"true": ..., "false": ...} descriptions.',
    ),
});

const modelSchema = z.string().optional().describe('Model alias. Omit to use the server default (`openjev`).');

const questionIdSchema = z
  .string()
  .optional()
  .describe('Label for this question in the response. Defaults to the primitive name.');

const choiceCriteriaSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.string())])
  .describe(
    'The options. An object maps each option name to a description of what it covers and excludes; an array of names is shorthand for options that need no description. Include an option named "other" or "none" when the list may not cover every input.',
  );

const scoreCriteriaSchema = z
  .array(z.unknown())
  .describe(
    'The ordered levels, lowest first. Each level is a self-contained description (a string, or an object/array holding meaning and examples). A three-level scale returns a score from 0 to 2; fractional scores fall between levels, so each level must stand on its own rather than say "same as the level below".',
  );

const noulCriteriaSchema = z
  .strictObject({
    true: z.unknown().optional().describe('What counts as yes.'),
    false: z.unknown().optional().describe('What counts as no.'),
  })
  .describe('Optional descriptions of the two outcomes. Omit when `instructions` already defines both.');

const criterionDescriptionSchema = z.unknown();

const answerSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('choice'),
    choice: z.string(),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    legend: z.record(z.string(), criterionDescriptionSchema),
    probabilities: z.record(z.string(), z.number()),
    confidence: z.number(),
  }),
  z.object({
    type: z.literal('noul'),
    noul: z.number(),
  }),
]);

const usageSchema = z.object({
  input_tokens: z.number().optional(),
  output_tokens: z.number().optional(),
});

const hintsSchema = z
  .array(z.string())
  .optional()
  .describe('Non-blocking advice about this request, when there is any.');

const modelOutSchema = z.string().optional();
const usageOutSchema = usageSchema.optional();

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

function errorResult(error: unknown): CallToolResult {
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
          text: `OpenJEV call failed: ${error.describe()}\n${nextStep(error)}\n${JSON.stringify(payload)}`,
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

/* -------------------------------------------------------------------------- */
/* Registration                                                               */
/* -------------------------------------------------------------------------- */

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

export function registerTools(server: McpServer, deps: ToolDependencies): void {
  const { client } = deps;

  server.registerTool(
    'jev_ask',
    {
      title: 'Ask Jev (batch)',
      description: [
        'Send one shared context and one or more independent questions to Jev (TypeSafe System One) and get typed judgments back — not prose.',
        '',
        'How to design the call:',
        '- `state` carries the text and facts; `instructions` carries the judgment, in the question\'s own words.',
        '- Every question is answered independently against the same state. Order is not a sequence, and no question can use another\'s answer. Ask independent questions together in one call, including conditional ones whose answers you may ignore; make a second call only when an answer decides what to fetch or ask next.',
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
}
