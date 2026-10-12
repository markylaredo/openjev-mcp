/**
 * Argument and result shapes for the tool surface.
 *
 * The descriptions here are the agent's documentation, as much as the tool
 * descriptions are: they say what each field means and how to fill it.
 */

import { z } from 'zod';

export const stateSchema = z
  .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
  .describe(
    'The content the questions are judged against: text, an object of named fields, or an array of records. The state is judged as one whole, so an array of tickets gets one blended answer rather than one per ticket; to judge records one by one, use `jev_batch`. Reference a nested field from `instructions` with a dotted path in backticks, e.g. `account.plan`. Fetch external records first — a URL here is not a request to browse — and note that this API accepts no image, audio, or file uploads.',
  );

export const instructionsSchema = z
  .union([z.string(), z.array(z.unknown()), z.record(z.string(), z.unknown())])
  .describe(
    'The judgment to make, written out in full. A clear specific string is usually enough; use an object or array when the judgment, its scope, and its constraints belong together. The question id is not sent to the model, so never rely on it to carry meaning.',
  );

export const questionSchema = z.object({
  type: z.enum(['choice', 'score', 'noul']).describe('choice: one of a set of named options. score: a position on an ordered scale. noul: a yes/no probability.'),
  instructions: instructionsSchema,
  criteria: z
    .union([z.record(z.string(), z.unknown()), z.array(z.unknown())])
    .optional()
    .describe(
      'The possible answers. For choice, an object of option name to description (or an array of option names as shorthand); up to 255 options. For score, an ordered array of levels, lowest first; up to 10. For noul, optional {"true": ..., "false": ...} descriptions.',
    ),
});

export const modelSchema = z.string().optional().describe('Model alias. Omit to use the server default (`openjev`).');

export const questionIdSchema = z
  .string()
  .optional()
  .describe('Label for this question in the response. Defaults to the primitive name.');

export const choiceCriteriaSchema = z
  .union([z.record(z.string(), z.unknown()), z.array(z.string())])
  .describe(
    'The options. An object maps each option name to a description of what it covers and excludes; an array of names is shorthand for options that need no description. Include an option named "other" or "none" when the list may not cover every input.',
  );

export const scoreCriteriaSchema = z
  .array(z.unknown())
  .describe(
    'The ordered levels, lowest first. Each level is a self-contained description (a string, or an object/array holding meaning and examples). A three-level scale returns a score from 0 to 2; fractional scores fall between levels, so each level must stand on its own rather than say "same as the level below".',
  );

export const noulCriteriaSchema = z
  .strictObject({
    true: z.unknown().optional().describe('What counts as yes.'),
    false: z.unknown().optional().describe('What counts as no.'),
  })
  .describe('Optional descriptions of the two outcomes. Omit when `instructions` already defines both.');

const criterionDescriptionSchema = z.unknown();

export const answerSchema = z.discriminatedUnion('type', [
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

export const hintsSchema = z
  .array(z.string())
  .optional()
  .describe('Non-blocking advice about this request, when there is any.');

export const modelOutSchema = z.string().optional();
export const usageOutSchema = usageSchema.optional();

export const batchItemSchema = z.strictObject({
  id: z
    .union([z.string(), z.number()])
    .optional()
    .describe(
      'Your label for this item, used as its key in `answers` or `errors`. Use the record\'s own id, such as a ticket number, so results map back without counting positions. Give every item an id or none; without ids, items are labelled by position from "0". Never sent to the model.',
    ),
  state: stateSchema.describe(
    'This item\'s content, judged on its own: text, an object of named fields, or an array of records. Fetch external records first — a URL here is not a request to browse.',
  ),
});

export const itemErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  status: z.number().optional(),
  retry_after_ms: z.number().optional(),
  details: z.string().optional(),
});
