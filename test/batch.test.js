/**
 * `jev_batch`: the same questions put to many items. Checked three ways — the
 * local rules on their own, the runner against a scripted client where timing
 * must be exact, and the tool over a real MCP connection to the mock API, where
 * each item is a real HTTP request.
 */

import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { after, afterEach, before, beforeEach, describe, it } from 'node:test';

import { MAX_BATCH_ITEMS, prepareBatch, runBatch } from '../dist/batch.js';
import { OpenJevError } from '../dist/errors.js';
import { answerBody, startMockOpenJev } from './support/mock-openjev.js';
import { connectInProcess, textPayload } from './support/harness.js';

/** An electric co-op's member messages, triaged with two questions each. */
const questions = {
  category: {
    type: 'choice',
    instructions: 'What is the member reporting?',
    criteria: { outage: 'Power is out', billing: 'A charge or a bill', other: 'Anything else' },
  },
  hazard: { type: 'noul', instructions: 'Does the message describe a safety hazard, such as a downed line?' },
};

function answersFor(category, hazard) {
  const probabilities = { outage: 0.05, billing: 0.05, other: 0.05, [category]: 0.9 };
  return {
    category: { type: 'choice', choice: category, probabilities, confidence: 0.8 },
    hazard: { type: 'noul', noul: hazard },
  };
}

const items = [
  { id: 'T-1001', state: 'Power has been out on Ridge Rd since 6am.' },
  { id: 'T-1002', state: 'My bill doubled this month and nothing changed.' },
  { id: 'T-1003', state: 'A line is down across our driveway and sparking.' },
];

/** The mock's reply for one request, chosen by the state it carries. */
function triage(request) {
  const state = request.body.state;
  if (state.includes('bill')) return { status: 200, body: answerBody(answersFor('billing', 0.02)) };
  if (state.includes('sparking')) return { status: 200, body: answerBody(answersFor('outage', 0.98)) };
  return { status: 200, body: answerBody(answersFor('outage', 0.1)) };
}

function lettered(count) {
  return Array.from({ length: count }, (_, index) => ({ id: String.fromCharCode(97 + index), state: `message ${index}` }));
}

/* -------------------------------------------------------------------------- */
/* Local rules                                                                */
/* -------------------------------------------------------------------------- */

describe('prepareBatch', () => {
  it('labels items by position when none has an id', () => {
    const { items: prepared, questions: converted, review } = prepareBatch(
      [{ state: 'one' }, { state: { message: 'two' } }],
      { team: { type: 'choice', instructions: 'Which team?', criteria: ['billing', 'other'] } },
    );
    assert.deepEqual(review.issues, []);
    assert.deepEqual(prepared, [{ id: '0', state: 'one' }, { id: '1', state: { message: 'two' } }]);
    assert.deepEqual(converted.team.criteria, { billing: null, other: null }, 'questions convert as in jev_ask');
  });

  it('keeps caller ids, and reads a numeric id as text', () => {
    const { items: prepared, review } = prepareBatch([{ id: 4521, state: 'a' }, { id: 'T-7', state: 'b' }], questions);
    assert.deepEqual(review.issues, []);
    assert.deepEqual(prepared.map(item => item.id), ['4521', 'T-7']);
  });

  it('reports every problem at once, each with its path', () => {
    const { review } = prepareBatch(
      [{ id: 'a', state: '' }, { id: 'a', state: 'x' }, { state: 'y' }, { id: ' ', state: 'z' }],
      { category: { type: 'choice', instructions: 'Which?', criteria: { only: null } } },
    );
    assert.deepEqual(
      review.issues.map(issue => `${issue.path}: ${issue.message}`),
      [
        'items[0].state: must not be empty',
        'items[1].id: "a" is also the id of items[0]; ids label the results, so each must be unique',
        'items[2].id: is missing; when any item has an id, every item needs one',
        'items[3].id: must not be empty',
        'questions.category.criteria: needs at least 2 options to be a choice; got 1',
      ],
    );
  });

  it('caps the items per call without reviewing each one', () => {
    const { review } = prepareBatch(Array.from({ length: MAX_BATCH_ITEMS + 1 }, () => ({ state: '' })), questions);
    assert.equal(review.issues.length, 1);
    assert.match(review.issues[0].message, /at most 100 items per call; got 101/);
    assert.deepEqual(prepareBatch([], questions).review.issues, [{ path: 'items', message: 'needs at least one item' }]);
  });

  it('passes the fallback-option hint through', () => {
    const { review } = prepareBatch([{ state: 'x' }], {
      team: { type: 'choice', instructions: 'Which team?', criteria: ['billing', 'sales'] },
    });
    assert.deepEqual(review.issues, []);
    assert.match(review.hints[0], /questions\.team\.criteria has no fallback option/);
  });
});

/* -------------------------------------------------------------------------- */
/* The runner, against a scripted client                                      */
/* -------------------------------------------------------------------------- */

const noulResponse = value => ({ model: 'openjev', answers: { q: { type: 'noul', noul: value } } });
const oneQuestion = { q: { type: 'noul', instructions: 'Is it urgent?' } };
const numbered = count => Array.from({ length: count }, (_, index) => ({ id: String(index), state: String(index) }));

describe('runBatch', () => {
  it('keeps no more requests in flight than its concurrency, and results in input order', async () => {
    let inFlight = 0;
    let peak = 0;
    const client = {
      async systemOne(request) {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        // Later items finish first, so completion order is the reverse of input order.
        await delay(20 - Number(request.state) * 2);
        inFlight -= 1;
        return noulResponse(Number(request.state) / 10);
      },
    };

    const result = await runBatch(client, { items: numbered(8), questions: oneQuestion }, { concurrency: 3, timeBudgetMs: 10_000 });

    assert.equal(peak, 3);
    assert.equal(result.stop, undefined);
    assert.deepEqual(
      result.outcomes.map(outcome => outcome.response.answers.q.noul),
      [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
    );
  });

  it('halves its concurrency and pauses new requests when the key is rate limited', async () => {
    let inFlight = 0;
    let peakAfterLimit = 0;
    let limited = false;
    const pauses = [];
    const client = {
      async systemOne(request, options) {
        inFlight += 1;
        if (limited) peakAfterLimit = Math.max(peakAfterLimit, inFlight);
        if (request.state === '0') {
          // What the real client reports before it waits out a 429.
          limited = true;
          options.onRetry(new OpenJevError({ code: 'rate_limited', message: 'slow down', retryAfterMs: 1_000 }), 1_000);
        }
        await delay(5);
        inFlight -= 1;
        return noulResponse(0.5);
      },
    };

    const result = await runBatch(
      client,
      { items: numbered(12), questions: oneQuestion },
      { concurrency: 4, timeBudgetMs: 10_000, sleepImpl: async ms => void pauses.push(ms) },
    );

    assert.ok(peakAfterLimit <= 2, `at most 2 requests in flight after the 429, saw ${peakAfterLimit}`);
    assert.ok(pauses.length > 0, 'new requests must wait out the interval');
    for (const ms of pauses) assert.ok(ms > 0 && ms <= 1_000, `pause of ${ms} ms`);
    assert.ok(result.outcomes.every(outcome => 'response' in outcome), 'every item is still answered');
  });

  it('stops sending when the caller cancels, and reports the item in flight as aborted', async () => {
    const controller = new AbortController();
    const sent = [];
    const client = {
      async systemOne(request, options) {
        sent.push(request.state);
        if (request.state === '0') return noulResponse(0.2);
        controller.abort();
        // A cancelled call rejects as aborted, as the real client's does.
        assert.equal(options.signal.aborted, true);
        throw new OpenJevError({ code: 'aborted', message: 'The request was cancelled before it completed.' });
      },
    };

    const result = await runBatch(
      client,
      { items: numbered(4), questions: oneQuestion },
      { concurrency: 1, timeBudgetMs: 10_000, signal: controller.signal },
    );

    assert.deepEqual(sent, ['0', '1']);
    assert.equal(result.stop.error.code, 'aborted');
    assert.equal(result.outcomes[1].error.code, 'aborted');
    assert.deepEqual(result.outcomes.slice(2), [undefined, undefined]);
  });

  it('treats an unexpected exception as a bug: it sends nothing more and rethrows', async () => {
    const sent = [];
    const client = {
      async systemOne(request) {
        sent.push(request.state);
        if (request.state === '1') throw new TypeError('boom');
        return noulResponse(0.5);
      },
    };

    await assert.rejects(
      runBatch(client, { items: numbered(4), questions: oneQuestion }, { concurrency: 1, timeBudgetMs: 10_000 }),
      error => error instanceof TypeError && error.message === 'boom',
    );
    assert.deepEqual(sent, ['0', '1']);
  });
});

/* -------------------------------------------------------------------------- */
/* The tool, over MCP, against the mock API                                   */
/* -------------------------------------------------------------------------- */

/** @type {Awaited<ReturnType<typeof startMockOpenJev>>} */
let mock;
const connections = [];

before(async () => {
  mock = await startMockOpenJev();
});

after(async () => {
  await mock.close();
});

beforeEach(() => {
  mock.requests.length = 0;
  mock.setResponder(triage);
});

afterEach(async () => {
  await Promise.all(connections.splice(0).map(connection => connection.close()));
});

/** A client connected to a fresh server with these `jev_batch` settings. */
async function connect(batch) {
  const connection = await connectInProcess({ baseUrl: mock.url, batch });
  connections.push(connection);
  return connection.client;
}

function callBatch(client, args, options) {
  return client.callTool({ name: 'jev_batch', arguments: { questions, ...args } }, undefined, options);
}

describe('jev_batch', () => {
  it('sends one request per item and returns answers keyed by item id', async () => {
    const client = await connect();

    const result = await callBatch(client, { items });

    assert.equal(result.isError, undefined);
    assert.equal(mock.requests.length, 3, 'one request per item');
    assert.deepEqual(mock.requests.map(request => request.body.state).sort(), items.map(item => item.state).sort());
    for (const request of mock.requests) {
      assert.deepEqual(Object.keys(request.body.questions), ['category', 'hazard'], 'every item gets every question');
    }

    const { structuredContent } = result;
    assert.deepEqual(structuredContent.counts, { total: 3, answered: 3, failed: 0, not_sent: 0 });
    assert.deepEqual(Object.keys(structuredContent.answers), ['T-1001', 'T-1002', 'T-1003']);
    assert.equal(structuredContent.answers['T-1002'].category.choice, 'billing');
    assert.equal(structuredContent.answers['T-1003'].hazard.noul, 0.98);
    assert.equal(structuredContent.model, 'openjev');
    assert.deepEqual(structuredContent.usage, { input_tokens: 300, output_tokens: 15 });
    for (const key of ['stopped', 'errors', 'not_sent', 'hints']) assert.equal(key in structuredContent, false, key);
    assert.equal(textPayload(result), JSON.stringify(structuredContent), 'compact JSON text mirrors the structure');
  });

  it('keeps the configured number of requests in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    mock.setResponder(async request => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await delay(50);
      inFlight -= 1;
      return triage(request);
    });
    const client = await connect({ concurrency: 2 });

    const result = await callBatch(client, { items: lettered(6) });

    assert.equal(result.structuredContent.counts.answered, 6);
    assert.equal(peak, 2);
  });

  it('keeps answering when one item fails, and reports that item', async () => {
    mock.setResponder(request =>
      request.body.state === 'message 1' ? { status: 422, body: { error: 'state could not be parsed' } } : triage(request),
    );
    const client = await connect();

    const result = await callBatch(client, { items: lettered(3) });

    assert.equal(result.isError, undefined);
    const { counts, answers, errors } = result.structuredContent;
    assert.deepEqual(counts, { total: 3, answered: 2, failed: 1, not_sent: 0 });
    assert.deepEqual(Object.keys(answers), ['a', 'c']);
    assert.equal(errors.b.code, 'invalid_request');
    assert.equal(errors.b.retryable, false);
    assert.equal(errors.b.status, 422);
    assert.match(errors.b.details, /could not be parsed/);
    assert.equal('stopped' in result.structuredContent, false);
  });

  it('stops on a rejected key and keeps what it already answered', async () => {
    mock.respondWith({ status: 200, body: answerBody(answersFor('outage', 0.1)) }, { status: 401, body: { error: 'invalid api key' } });
    const client = await connect({ concurrency: 1 });

    const result = await callBatch(client, { items: lettered(3) });

    assert.equal(mock.requests.length, 2, 'nothing is sent after the key is rejected');
    const { counts, answers, errors, stopped, not_sent: notSent } = result.structuredContent;
    assert.deepEqual(counts, { total: 3, answered: 1, failed: 1, not_sent: 1 });
    assert.deepEqual(Object.keys(answers), ['a']);
    assert.equal(errors.b.code, 'auth');
    assert.deepEqual(notSent, ['c']);
    assert.equal(stopped.code, 'auth');
    assert.equal(stopped.retryable, false);
    assert.match(stopped.message, /OPENJEV_API_KEY/);
  });

  it('is a tool error when it answers nothing', async () => {
    mock.respondWith({ status: 401, body: { error: 'invalid api key' } });
    const client = await connect({ concurrency: 1 });

    const result = await callBatch(client, { items: lettered(3) });

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    const text = textPayload(result);
    assert.match(text, /^OpenJEV batch answered none of its 3 items \(1 failed, 2 not sent\): OpenJEV rejected the API key/);
    assert.match(text, /Next step: check OPENJEV_API_KEY/);
    assert.match(text, /"code":"auth"/);
    assert.equal(mock.requests.length, 1);
  });

  it('stops when the rate limit outlasts what one call waits, and says when to resume', async () => {
    mock.respondWith(
      { status: 200, body: answerBody(answersFor('outage', 0.1)) },
      { status: 429, headers: { 'retry-after': '600' }, body: { error: 'slow down' } },
    );
    const client = await connect({ concurrency: 1 });

    const result = await callBatch(client, { items: lettered(3) });

    assert.equal(mock.requests.length, 2);
    const { counts, errors, stopped, not_sent: notSent } = result.structuredContent;
    assert.deepEqual(counts, { total: 3, answered: 1, failed: 1, not_sent: 1 });
    assert.equal(errors.b.code, 'rate_limited');
    assert.deepEqual(notSent, ['c']);
    assert.deepEqual(
      { code: stopped.code, retryable: stopped.retryable, retry_after_ms: stopped.retry_after_ms },
      { code: 'rate_limited', retryable: true, retry_after_ms: 600_000 },
    );
    assert.match(stopped.message, /retry_after_ms/);
  });

  it('waits out a short rate limit before sending the next item', async () => {
    mock.respondWith(
      { status: 429, headers: { 'retry-after': '1' }, body: { error: 'slow down' } },
      { status: 200, body: answerBody(answersFor('outage', 0.1)) },
    );
    const pauses = [];
    const client = await connect({ concurrency: 1, sleepImpl: async ms => void pauses.push(ms) });

    const result = await callBatch(client, { items: lettered(2) });

    assert.equal(result.structuredContent.counts.answered, 2);
    assert.equal(mock.requests.length, 3, 'the first item is retried once');
    assert.equal(pauses.length, 1, 'the second item waits for the interval the 429 asked for');
    assert.ok(pauses[0] > 0 && pauses[0] <= 1_000, `pause of ${pauses[0]} ms`);
  });

  it('stops after three items fail in a row', async () => {
    mock.setResponder((request, callNumber) =>
      callNumber === 1 ? triage(request) : { status: 503, body: { error: 'temporarily unavailable' } },
    );
    const client = await connect({ concurrency: 1 });

    const result = await callBatch(client, { items: lettered(5) });

    assert.equal(mock.requests.length, 1 + 3 * 3, 'three failing items, each tried three times');
    const { counts, stopped, not_sent: notSent } = result.structuredContent;
    assert.deepEqual(counts, { total: 5, answered: 1, failed: 3, not_sent: 1 });
    assert.deepEqual(notSent, ['e']);
    assert.equal(stopped.code, 'unavailable');
    assert.equal(stopped.retryable, true);
    assert.match(stopped.message, /^3 items in a row failed/);
  });

  it('ends at its time budget with the answers it has', async () => {
    mock.setResponder((request, callNumber) => (callNumber === 1 ? triage(request) : { hang: true }));
    const client = await connect({ concurrency: 1, timeBudgetMs: 200 });

    const started = Date.now();
    const result = await callBatch(client, { items: lettered(3) });

    assert.ok(Date.now() - started < 2_000, 'the budget bounds the call');
    const { counts, errors, stopped, not_sent: notSent } = result.structuredContent;
    assert.deepEqual(counts, { total: 3, answered: 1, failed: 1, not_sent: 1 });
    assert.equal(errors.b.code, 'timeout');
    assert.match(errors.b.message, /200 ms time budget/);
    assert.deepEqual(notSent, ['c']);
    assert.equal(stopped.code, 'timeout');
    assert.equal(stopped.retryable, true);
  });

  it('reports progress to a caller that asks for it', async () => {
    const client = await connect({ concurrency: 1 });
    const progress = [];

    await callBatch(client, { items }, { onprogress: update => progress.push(update) });

    assert.deepEqual(progress.map(update => update.progress), [1, 2, 3]);
    assert.ok(progress.every(update => update.total === 3));
    assert.equal(progress.at(-1).message, '3 answered, 0 failed');
  });

  it('rejects an invalid batch before spending a call', async () => {
    const client = await connect();

    const local = await callBatch(client, { items: [{ id: 'a', state: '' }, { id: 'a', state: 'x' }] });
    assert.equal(local.isError, true);
    assert.match(textPayload(local), /items\[0\]\.state: must not be empty/);
    assert.match(textPayload(local), /items\[1\]\.id: "a" is also the id of items\[0\]/);

    const tooMany = await callBatch(client, { items: Array.from({ length: 101 }, () => ({ state: 'x' })) });
    assert.equal(tooMany.isError, true);
    assert.match(textPayload(tooMany), /Too big: expected array to have <=100 items at items/);

    const typo = await callBatch(client, { items: [{ id: 'a', text: 'x' }] });
    assert.equal(typo.isError, true);
    assert.match(textPayload(typo), /Unrecognized key: "text"/);

    assert.equal(mock.requests.length, 0);
  });

  it('treats an item id like __proto__ as an ordinary label', async () => {
    const client = await connect();

    const result = await callBatch(client, { items: [{ id: '__proto__', state: 'x' }, { id: 'b', state: 'y' }] });

    const { answers } = result.structuredContent;
    assert.equal(Object.hasOwn(answers, '__proto__'), true);
    assert.equal(answers['__proto__'].category.choice, 'outage');
    assert.equal(Object.getPrototypeOf(answers), Object.prototype);
  });
});
