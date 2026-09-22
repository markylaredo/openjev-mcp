/**
 * Turning tool arguments into a wire request, checked locally before any HTTP
 * call.
 *
 * The endpoint enforces its own contract and answers a bad body with 422, but a
 * round trip costs latency and says less about what to fix. The rules here are
 * the documented ones — option and level counts, criterion description shapes,
 * non-empty state and questions — plus one non-blocking hint for a choice list
 * with no escape hatch. Nothing here is a judgment; it is all exact rules.
 */

import type {
  ChoiceQuestion,
  CriterionDescription,
  Instructions,
  NoulQuestion,
  Question,
  ScoreQuestion,
  State,
} from './types.js';

/** Documented criteria limits. */
export const LIMITS = {
  choiceMinOptions: 2,
  choiceMaxOptions: 255,
  scoreMinLevels: 2,
  scoreMaxLevels: 10,
} as const;

export interface QuestionIssue {
  /** Dotted path to the offending value, e.g. `questions.team.criteria`. */
  path: string;
  message: string;
}

export interface Review {
  /** Blocking problems. Any issue means the request would be rejected or meaningless. */
  issues: QuestionIssue[];
  /** Non-blocking advice that may improve the call. */
  hints: string[];
}

/** A question as it arrives from a tool argument, before the type is trusted. */
export interface RawQuestion {
  type: string;
  instructions?: unknown;
  criteria?: unknown;
}

export interface PreparedRequest {
  state: State;
  questions: Record<string, Question>;
  review: Review;
}

export function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Names that let a choice cover inputs the option list did not anticipate. */
const ESCAPE_HATCHES = ['other', 'none', 'unknown', 'none_of_the_above', 'unclear'];

function reviewDescription(path: string, value: unknown, issues: QuestionIssue[]): void {
  const ok = value === null || typeof value === 'string' || Array.isArray(value) || isPlainObject(value);
  if (!ok) {
    issues.push({
      path,
      message: `a criterion description must be a string, object, array, or null (got ${typeName(value)})`,
    });
  }
}

function reviewInstructions(path: string, value: unknown, issues: QuestionIssue[]): void {
  if (isNonEmptyText(value)) return;
  if (Array.isArray(value)) {
    if (value.length === 0) issues.push({ path, message: 'must not be an empty array' });
    return;
  }
  if (isPlainObject(value)) {
    if (Object.keys(value).length === 0) issues.push({ path, message: 'must not be an empty object' });
    return;
  }
  issues.push({
    path,
    message: `must hold the judgment itself: a question string, or an object or array keeping the judgment and its constraints together (got ${typeName(value)})`,
  });
}

function reviewState(state: unknown, issues: QuestionIssue[]): void {
  if (typeof state === 'string') {
    if (state.trim().length === 0) issues.push({ path: 'state', message: 'must not be empty' });
    return;
  }
  if (Array.isArray(state)) {
    if (state.length === 0) issues.push({ path: 'state', message: 'must not be an empty array' });
    return;
  }
  if (isPlainObject(state)) {
    if (Object.keys(state).length === 0) issues.push({ path: 'state', message: 'must not be an empty object' });
    return;
  }
  issues.push({ path: 'state', message: `must be a string, object, or array (got ${typeName(state)})` });
}

function reviewChoice(path: string, criteria: Record<string, CriterionDescription>, review: Review): void {
  const { issues, hints } = review;
  const names = Object.keys(criteria);
  if (names.length < LIMITS.choiceMinOptions) {
    issues.push({
      path: `${path}.criteria`,
      message: `needs at least ${LIMITS.choiceMinOptions} options to be a choice; got ${names.length}`,
    });
  }
  if (names.length > LIMITS.choiceMaxOptions) {
    issues.push({
      path: `${path}.criteria`,
      message: `allows at most ${LIMITS.choiceMaxOptions} options; got ${names.length}`,
    });
  }
  for (const name of names) {
    if (name.trim().length === 0) {
      issues.push({ path: `${path}.criteria`, message: 'option names must not be empty' });
      continue;
    }
    reviewDescription(`${path}.criteria.${name}`, criteria[name], issues);
  }
  const lowered = names.map(name => name.trim().toLowerCase());
  if (!lowered.some(name => ESCAPE_HATCHES.includes(name))) {
    hints.push(
      `${path}.criteria has no fallback option. When the list may not cover every input, add an option named "other" or "none" so the judgment is not forced onto a listed option.`,
    );
  }
}

function reviewScore(path: string, criteria: unknown[], review: Review): void {
  const { issues } = review;
  if (criteria.length < LIMITS.scoreMinLevels) {
    issues.push({
      path: `${path}.criteria`,
      message: `needs at least ${LIMITS.scoreMinLevels} ordered levels; got ${criteria.length}`,
    });
  }
  if (criteria.length > LIMITS.scoreMaxLevels) {
    issues.push({
      path: `${path}.criteria`,
      message: `allows at most ${LIMITS.scoreMaxLevels} ordered levels; got ${criteria.length}`,
    });
  }
  criteria.forEach((level, index) => {
    reviewDescription(`${path}.criteria[${index}]`, level, issues);
  });
}

function reviewNoul(path: string, criteria: Record<string, unknown>, review: Review): void {
  for (const [key, value] of Object.entries(criteria)) {
    if (key !== 'true' && key !== 'false') {
      review.issues.push({
        path: `${path}.criteria.${key}`,
        message:
          'the only recognised keys are "true" and "false"; omit criteria entirely when the instructions already define both outcomes',
      });
      continue;
    }
    reviewDescription(`${path}.criteria.${key}`, value, review.issues);
  }
}

function reviewQuestion(path: string, question: Question, review: Review): void {
  reviewInstructions(`${path}.instructions`, question.instructions, review.issues);
  switch (question.type) {
    case 'choice':
      reviewChoice(path, question.criteria, review);
      return;
    case 'score':
      reviewScore(path, question.criteria, review);
      return;
    case 'noul':
      if (question.criteria !== undefined) reviewNoul(path, question.criteria, review);
      return;
  }
}

/** Convert one raw question to its wire form, reporting anything unusable. */
function toQuestion(path: string, raw: RawQuestion, issues: QuestionIssue[]): Question | undefined {
  const instructions = raw.instructions as Instructions;

  if (raw.type === 'choice') {
    const criteria = raw.criteria;
    if (Array.isArray(criteria)) {
      const options: Record<string, CriterionDescription> = {};
      let unusable = false;
      criteria.forEach((name, index) => {
        if (isNonEmptyText(name)) {
          options[name] = null;
        } else {
          unusable = true;
          issues.push({
            path: `${path}.criteria[${index}]`,
            message: `the array shorthand takes option names as non-empty strings; use the object form to attach a description (got ${typeName(name)})`,
          });
        }
      });
      // A list that lost entries would also fail the option-count check, and
      // reporting that as a second problem would only bury the real one.
      if (unusable) return undefined;
      const question: ChoiceQuestion = { type: 'choice', instructions, criteria: options };
      return question;
    }
    if (!isPlainObject(criteria)) {
      issues.push({
        path: `${path}.criteria`,
        message: `must be an object of named options, or an array of option names (got ${typeName(criteria)})`,
      });
      return undefined;
    }
    return { type: 'choice', instructions, criteria: criteria as Record<string, CriterionDescription> };
  }

  if (raw.type === 'score') {
    const criteria = raw.criteria;
    if (!Array.isArray(criteria)) {
      issues.push({
        path: `${path}.criteria`,
        message: `must be an ordered array of levels, lowest first (got ${typeName(criteria)})`,
      });
      return undefined;
    }
    const question: ScoreQuestion = { type: 'score', instructions, criteria };
    return question;
  }

  if (raw.type === 'noul') {
    const criteria = raw.criteria;
    if (criteria !== undefined && !isPlainObject(criteria)) {
      issues.push({
        path: `${path}.criteria`,
        message: `must be an object holding "true" and/or "false" descriptions, or be omitted (got ${typeName(criteria)})`,
      });
      return undefined;
    }
    const question: NoulQuestion = { type: 'noul', instructions };
    if (criteria !== undefined) question.criteria = criteria;
    return question;
  }

  issues.push({
    path: `${path}.type`,
    message: `must be "choice", "score", or "noul" (got ${JSON.stringify(raw.type)})`,
  });
  return undefined;
}

/**
 * Validate every part of a request before it is sent.
 *
 * Always returns a request: callers inspect `review.issues` and skip the HTTP
 * call when it is non-empty. Questions that fail conversion are left out of
 * `questions` so the remaining issues stay readable.
 */
export function prepareRequest(state: unknown, rawQuestions: Record<string, RawQuestion>): PreparedRequest {
  const review: Review = { issues: [], hints: [] };
  reviewState(state, review.issues);

  const ids = Object.keys(rawQuestions);
  if (ids.length === 0) {
    review.issues.push({ path: 'questions', message: 'needs at least one question' });
  }

  const converted: Array<[string, Question]> = [];
  for (const id of ids) {
    if (id.trim().length === 0) {
      review.issues.push({ path: 'questions', message: 'question ids must not be empty' });
      continue;
    }
    const raw = rawQuestions[id] as RawQuestion;
    const question = toQuestion(`questions.${id}`, raw, review.issues);
    if (question === undefined) continue;
    converted.push([id, question]);
    reviewQuestion(`questions.${id}`, question, review);
  }

  // Defined as own properties, so an id such as `__proto__` is carried through
  // like any other label instead of mutating the object's prototype.
  return { state: state as State, questions: Object.fromEntries(converted), review };
}

/** Render issues as one agent-readable block, one problem per line. */
export function formatIssues(issues: QuestionIssue[]): string {
  const heading =
    issues.length === 1
      ? 'OpenJEV rejected this request locally, before spending a call:'
      : `OpenJEV rejected this request locally, before spending a call (${issues.length} problems):`;
  return [heading, ...issues.map(issue => `  - ${issue.path}: ${issue.message}`)].join('\n');
}
