/**
 * Wire types for the OpenJEV / System One endpoint.
 *
 * These mirror the documented request and response contracts at
 * https://openjev.sh/docs and https://openjev.sh/docs/advanced. They describe
 * what we send and what we accept back; they deliberately add no policy.
 */

/** Any JSON value. Used for nested state, instructions, and criteria descriptions. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The top-level shapes OpenJEV accepts for `state`. */
export type State = string | JsonValue[] | { [key: string]: JsonValue };

/** The shapes OpenJEV accepts for `instructions`. */
export type Instructions = string | JsonValue[] | { [key: string]: JsonValue };

/** A description attached to a criterion: free-form JSON, or null when the name says enough. */
export type CriterionDescription = JsonValue;

/** Choice: one of a set of named options. Up to 255 options. */
export interface ChoiceQuestion {
  type: 'choice';
  instructions: Instructions;
  /** Named options. The keys are the values the caller receives in `choice`. */
  criteria: Record<string, CriterionDescription>;
}

/** Score: a position on an ordered scale. Up to 10 levels, numbered from zero. */
export interface ScoreQuestion {
  type: 'score';
  instructions: Instructions;
  /** Ordered levels; positional index is the level number. */
  criteria: CriterionDescription[];
}

/** Noul: a yes/no probability. `criteria` is optional. */
export interface NoulQuestion {
  type: 'noul';
  instructions: Instructions;
  criteria?: { true?: CriterionDescription; false?: CriterionDescription } | undefined;
}

export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;
export type QuestionType = Question['type'];

export interface SystemOneRequest {
  model?: string | undefined;
  state: State;
  questions: Record<string, Question>;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  legend: Record<string, CriterionDescription>;
  probabilities: Record<string, number>;
  confidence: number;
}

export interface NoulAnswer {
  type: 'noul';
  noul: number;
}

export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

/** Token usage for a request. Not a currency amount or a remaining quota. */
export interface Usage {
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
}

export interface SystemOneResponse {
  model?: string | undefined;
  answers: Record<string, Answer>;
  usage?: Usage | undefined;
}
