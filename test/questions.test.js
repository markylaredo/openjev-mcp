/**
 * Local request review: the documented rules are enforced before a call is
 * spent, with a message that says which value is wrong.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { formatIssues, LIMITS, prepareRequest } from '../dist/questions.js';

const noul = { type: 'noul', instructions: 'Is this urgent?' };

/** @returns {string[]} issue paths, for compact assertions */
function paths(review) {
  return review.issues.map(issue => issue.path);
}

describe('a valid request passes untouched', () => {
  it('keeps every primitive and reports nothing', () => {
    const { state, questions, review } = prepareRequest(
      { message: 'My bill doubled.', account: { plan: 'residential' } },
      {
        team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 'Payments', other: null } },
        severity: { type: 'score', instructions: 'How bad?', criteria: ['None', 'Mild', 'Serious'] },
        urgent: noul,
      },
    );

    assert.deepEqual(review.issues, []);
    assert.deepEqual(review.hints, []);
    assert.deepEqual(Object.keys(questions), ['team', 'severity', 'urgent']);
    assert.deepEqual(state, { message: 'My bill doubled.', account: { plan: 'residential' } });
    assert.deepEqual(questions.severity.criteria, ['None', 'Mild', 'Serious']);
    assert.equal(questions.urgent.criteria, undefined);
  });

  it('accepts instructions that carry their own structure', () => {
    const { review } = prepareRequest('state', {
      cancellation: {
        type: 'noul',
        instructions: {
          question: 'Does the message explicitly request cancellation?',
          scope: 'Judge the stated intent, not whether cancellation is allowed.',
          evidence: ['A direct request to cancel'],
        },
      },
    });
    assert.deepEqual(review.issues, []);
  });
});

describe('the array shorthand for choice options', () => {
  it('becomes options with no description', () => {
    const { questions, review } = prepareRequest('state', {
      team: { type: 'choice', instructions: 'Which team?', criteria: ['billing', 'technical'] },
    });
    assert.deepEqual(review.issues, []);
    assert.deepEqual(questions.team.criteria, { billing: null, technical: null });
  });

  it('rejects entries that are not names', () => {
    const { review } = prepareRequest('state', {
      team: { type: 'choice', instructions: 'Which team?', criteria: ['billing', 7] },
    });
    assert.deepEqual(paths(review), ['questions.team.criteria[1]']);
    assert.match(review.issues[0].message, /non-empty strings/);
  });
});

describe('choice rules', () => {
  it('requires at least two options', () => {
    const { review } = prepareRequest('state', {
      team: { type: 'choice', instructions: 'Which team?', criteria: { billing: null } },
    });
    assert.deepEqual(paths(review), ['questions.team.criteria']);
    assert.match(review.issues[0].message, /at least 2 options/);
  });

  it(`allows at most ${LIMITS.choiceMaxOptions} options`, () => {
    const criteria = Object.fromEntries(Array.from({ length: 256 }, (_, index) => [`option_${index}`, null]));
    const { review } = prepareRequest('state', {
      team: { type: 'choice', instructions: 'Which team?', criteria },
    });
    assert.match(review.issues[0].message, /at most 255 options; got 256/);
  });

  it('requires a container of options, not a bare string', () => {
    const { review } = prepareRequest('state', {
      team: { type: 'choice', instructions: 'Which team?', criteria: 'billing' },
    });
    assert.match(review.issues[0].message, /must be an object of named options/);
  });

  it('rejects a description that is not text, an object, an array, or null', () => {
    const { review } = prepareRequest('state', {
      team: { type: 'choice', instructions: 'Which team?', criteria: { billing: 7, other: null } },
    });
    assert.equal(review.issues[0].path, 'questions.team.criteria.billing');
    assert.match(review.issues[0].message, /got number/);
  });

  it('hints when the list has no fallback option, without blocking the call', () => {
    const { review } = prepareRequest('state', {
      team: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, sales: null } },
    });
    assert.deepEqual(review.issues, []);
    assert.equal(review.hints.length, 1);
    assert.match(review.hints[0], /add an option named "other" or "none"/);
  });

  it('does not hint when "other" is present in any casing', () => {
    const { review } = prepareRequest('state', {
      team: { type: 'choice', instructions: 'Which team?', criteria: { billing: null, Other: null } },
    });
    assert.deepEqual(review.hints, []);
  });
});

describe('score rules', () => {
  it('requires an ordered array of levels', () => {
    const { review } = prepareRequest('state', {
      severity: { type: 'score', instructions: 'How bad?', criteria: { low: 'a', high: 'b' } },
    });
    assert.match(review.issues[0].message, /ordered array of levels/);
  });

  it('requires at least two levels and allows at most ten', () => {
    const one = prepareRequest('state', {
      severity: { type: 'score', instructions: 'How bad?', criteria: ['None'] },
    });
    assert.match(one.review.issues[0].message, /at least 2 ordered levels/);

    const eleven = prepareRequest('state', {
      severity: { type: 'score', instructions: 'How bad?', criteria: Array.from({ length: 11 }, (_, i) => `level ${i}`) },
    });
    assert.match(eleven.review.issues[0].message, /at most 10 ordered levels; got 11/);
  });

  it('accepts structured levels', () => {
    const { review } = prepareRequest('state', {
      severity: {
        type: 'score',
        instructions: 'How bad?',
        criteria: [{ meaning: 'No time pressure' }, { meaning: 'Immediate action requested', examples: ['Please help now'] }],
      },
    });
    assert.deepEqual(review.issues, []);
  });
});

describe('noul rules', () => {
  it('accepts both outcomes described, one described, or neither', () => {
    for (const criteria of [undefined, { true: 'Yes means this' }, { true: 'a', false: 'b' }]) {
      const question = { type: 'noul', instructions: 'Is this urgent?' };
      if (criteria !== undefined) question.criteria = criteria;
      const { review } = prepareRequest('state', { urgent: question });
      assert.deepEqual(review.issues, []);
    }
  });

  it('rejects keys other than true and false', () => {
    const { review } = prepareRequest('state', {
      urgent: { type: 'noul', instructions: 'Is this urgent?', criteria: { yes: 'a', no: 'b' } },
    });
    assert.deepEqual(paths(review), ['questions.urgent.criteria.yes', 'questions.urgent.criteria.no']);
    assert.match(review.issues[0].message, /only recognised keys are "true" and "false"/);
  });
});

describe('state rules', () => {
  it('rejects an empty or wrongly typed state', () => {
    assert.match(prepareRequest('   ', { q: noul }).review.issues[0].message, /must not be empty/);
    assert.match(prepareRequest([], { q: noul }).review.issues[0].message, /must not be an empty array/);
    assert.match(prepareRequest({}, { q: noul }).review.issues[0].message, /must not be an empty object/);
    assert.match(prepareRequest(42, { q: noul }).review.issues[0].message, /must be a string, object, or array \(got number\)/);
  });

  it('accepts an array of records, as the docs show for a conversation', () => {
    const { review } = prepareRequest(
      [
        { speaker: 'member', text: 'Can I pay in installments?' },
        { speaker: 'support', text: 'Yes, over three months.' },
      ],
      { q: noul },
    );
    assert.deepEqual(review.issues, []);
  });
});

describe('question map rules', () => {
  it('requires at least one question', () => {
    const { review } = prepareRequest('state', {});
    assert.deepEqual(paths(review), ['questions']);
    assert.match(review.issues[0].message, /at least one question/);
  });

  it('rejects an empty question id', () => {
    const { review } = prepareRequest('state', { '  ': noul });
    assert.deepEqual(paths(review), ['questions']);
    assert.match(review.issues[0].message, /ids must not be empty/);
  });

  it('rejects instructions that do not carry a judgment', () => {
    const { review } = prepareRequest('state', { q: { type: 'noul', instructions: '   ' } });
    assert.deepEqual(paths(review), ['questions.q.instructions']);
    assert.match(review.issues[0].message, /must hold the judgment itself/);
  });

  it('rejects an unknown primitive', () => {
    const { review } = prepareRequest('state', { q: { type: 'ranking', instructions: 'Order these.' } });
    assert.deepEqual(paths(review), ['questions.q.type']);
    assert.match(review.issues[0].message, /must be "choice", "score", or "noul"/);
  });

  it('keeps the questions that converted and reports the one that did not', () => {
    const { questions, review } = prepareRequest('state', {
      good: noul,
      bad: { type: 'score', instructions: 'How bad?', criteria: 'not a list' },
    });
    assert.deepEqual(Object.keys(questions), ['good']);
    assert.deepEqual(paths(review), ['questions.bad.criteria']);
  });

  it('carries an id like __proto__ through as a normal label', () => {
    const { questions, review } = prepareRequest('state', { ['__proto__']: noul });
    assert.deepEqual(review.issues, []);
    assert.equal(Object.hasOwn(questions, '__proto__'), true);
    assert.equal(questions['__proto__'].type, 'noul');
    assert.equal(Object.getPrototypeOf(questions), Object.prototype);
  });

  it('collects every problem rather than stopping at the first', () => {
    const { review } = prepareRequest('', {
      a: { type: 'choice', instructions: '', criteria: { only: null } },
      b: { type: 'noul', instructions: 'ok?', criteria: { maybe: 'x' } },
    });
    assert.deepEqual(paths(review), [
      'state',
      'questions.a.instructions',
      'questions.a.criteria',
      'questions.b.criteria.maybe',
    ]);
  });
});

describe('formatIssues', () => {
  it('lists each problem on its own line with its path', () => {
    const { review } = prepareRequest('', { q: { type: 'noul', instructions: '' } });
    const rendered = formatIssues(review.issues);
    assert.match(rendered, /^OpenJEV rejected this request locally/);
    assert.match(rendered, /\n {2}- state: /);
    assert.match(rendered, /\n {2}- questions\.q\.instructions: /);
  });
});
