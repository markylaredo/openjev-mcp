/**
 * Client behaviour: the request that leaves, the responses that are accepted,
 * and how every documented failure is classified.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { OpenJevClient, parseRetryAfter, parseSystemOneResponse } from '../dist/client.js';
import { answerBody, startMockOpenJev } from './support/mock-openjev.js';

/** @type {Awaited<ReturnType<typeof startMockOpenJev>>} */
let mock;

before(async () => {
  mock = await startMockOpenJev();
});

beforeEach(() => {
  mock.requests.length = 0;
});

after(async () => {
  await mock.close();
});

function makeClient(overrides = {}) {
  return new OpenJevClient({
    apiKey: 'test-key',
    baseUrl: mock.url,
    sleepImpl: async () => {},
    retryBaseDelayMs: 1,
    maxRetries: 0,
    ...overrides,
  });
}

const oneQuestion = { verdict: { type: 'noul', instructions: 'Is this urgent?' } };

describe('the request it sends', () => {
  it('posts state and questions to /v1/systemone with a bearer token', async () => {
    mock.respondWith({ status: 200, body: answerBody({ verdict: { type: 'noul', noul: 0.91 } }) });
    const client = makeClient();

    const response = await client.systemOne({ state: 'The power is out.', questions: oneQuestion });

    assert.equal(response.answers.verdict.noul, 0.91);
    assert.equal(mock.requests.length, 1);
    const request = mock.requests[0];
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/v1/systemone');
    assert.equal(request.headers.authorization, 'Bearer test-key');
    assert.match(request.headers['content-type'], /application\/json/);
    assert.deepEqual(request.body.state, 'The power is out.');
    assert.deepEqual(request.body.questions, oneQuestion);
  });

  it('omits `model` unless one is configured, and sends the configured default', async () => {
    mock.respondWith({ status: 200, body: answerBody({ verdict: { type: 'noul', noul: 0.5 } }) });
    await makeClient().systemOne({ state: 'x', questions: oneQuestion });
    assert.equal('model' in mock.requests.at(-1).body, false);

    await makeClient({ defaultModel: 'openjev' }).systemOne({ state: 'x', questions: oneQuestion });
    assert.equal(mock.requests.at(-1).body.model, 'openjev');

    await makeClient({ defaultModel: 'openjev' }).systemOne({
      state: 'x',
      questions: oneQuestion,
      model: 'other',
    });
    assert.equal(mock.requests.at(-1).body.model, 'other');
  });

  it('trims a trailing slash from the base URL', async () => {
    mock.respondWith({ status: 200, body: answerBody({ verdict: { type: 'noul', noul: 0.5 } }) });
    const client = makeClient({ baseUrl: `${mock.url}/` });
    assert.equal(client.endpoint, mock.endpoint);
    await client.systemOne({ state: 'x', questions: oneQuestion });
    assert.equal(mock.requests.at(-1).url, '/v1/systemone');
  });
});

describe('authentication and configuration failures', () => {
  it('refuses to construct without an API key', () => {
    assert.throws(
      () => new OpenJevClient({ apiKey: '   ' }),
      error => error.code === 'missing_api_key' && /OPENJEV_API_KEY/.test(error.message),
    );
  });

  it('classifies 401 as auth, tells the caller to fix the key, and does not retry', async () => {
    mock.respondWith({ status: 401, body: { error: 'invalid api key' } });
    const client = makeClient({ maxRetries: 3 });

    await assert.rejects(client.systemOne({ state: 'x', questions: oneQuestion }), error => {
      assert.equal(error.code, 'auth');
      assert.equal(error.status, 401);
      assert.equal(error.retryable, false);
      assert.match(error.message, /OPENJEV_API_KEY/);
      return true;
    });
    assert.equal(mock.requests.length, 1, 'a credentials failure must not be retried');
  });

  it('classifies 422 as invalid_request and keeps the server detail', async () => {
    mock.respondWith({ status: 422, body: { error: 'questions must be a non-empty object' } });
    const client = makeClient({ maxRetries: 3 });

    await assert.rejects(client.systemOne({ state: 'x', questions: oneQuestion }), error => {
      assert.equal(error.code, 'invalid_request');
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, { error: 'questions must be a non-empty object' });
      return true;
    });
    assert.equal(mock.requests.length, 1);
  });
});

describe('transient failures', () => {
  it('honors Retry-After and succeeds on the retry', async () => {
    mock.respondWith(
      { status: 429, headers: { 'retry-after': '2' }, body: { error: 'slow down' } },
      { status: 200, body: answerBody({ verdict: { type: 'noul', noul: 0.8 } }) },
    );
    const client = makeClient({ maxRetries: 1 });

    const response = await client.systemOne({ state: 'x', questions: oneQuestion });

    assert.equal(response.answers.verdict.noul, 0.8);
    assert.equal(mock.requests.length, 2, 'the 429 should be retried once');
  });

  it('gives up on a Retry-After longer than the wait we are willing to take', async () => {
    mock.respondWith({ status: 429, headers: { 'retry-after': '600' }, body: { error: 'slow down' } });
    const client = makeClient({ maxRetries: 3, maxRetryAfterMs: 1000 });

    await assert.rejects(client.systemOne({ state: 'x', questions: oneQuestion }), error => {
      assert.equal(error.code, 'rate_limited');
      assert.equal(error.retryAfterMs, 600_000);
      return true;
    });
    assert.equal(mock.requests.length, 1, 'a ten-minute wait is surfaced, not slept through');
  });

  it('retries 503 and then succeeds', async () => {
    mock.respondWith(
      { status: 503, body: { error: 'temporarily unavailable' } },
      { status: 200, body: answerBody({ verdict: { type: 'noul', noul: 0.7 } }) },
    );
    const response = await makeClient({ maxRetries: 2 }).systemOne({ state: 'x', questions: oneQuestion });
    assert.equal(response.answers.verdict.noul, 0.7);
    assert.equal(mock.requests.length, 2);
  });

  it('stops after the retry budget and reports unavailable', async () => {
    mock.respondWith({ status: 503, body: { error: 'down' } });

    await assert.rejects(
      makeClient({ maxRetries: 2 }).systemOne({ state: 'x', questions: oneQuestion }),
      error => error.code === 'unavailable' && error.retryable === true,
    );
    assert.equal(mock.requests.length, 3, 'one attempt plus two retries');
  });

  it('classifies a request that never answers as a timeout', async () => {
    mock.respondWith({ hang: true });

    await assert.rejects(
      makeClient({ timeoutMs: 150 }).systemOne({ state: 'x', questions: oneQuestion }),
      error => error.code === 'timeout' && error.retryable === true && /150 ms/.test(error.message),
    );
  });

  it('reports an unreachable host as a network failure', async () => {
    const client = new OpenJevClient({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1', maxRetries: 0, sleepImpl: async () => {} });

    await assert.rejects(
      client.systemOne({ state: 'x', questions: oneQuestion }),
      error => error.code === 'network' && /OPENJEV_BASE_URL/.test(error.message),
    );
  });

  it('reports caller cancellation as aborted, not as a timeout', async () => {
    mock.respondWith({ hang: true });
    const controller = new AbortController();
    const client = makeClient({ timeoutMs: 5_000 });

    const pending = client.systemOne({ state: 'x', questions: oneQuestion }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);

    await assert.rejects(pending, error => error.code === 'aborted' && error.retryable === false);
  });
});

describe('response contract', () => {
  it('accepts the three documented answer shapes', () => {
    const response = parseSystemOneResponse(
      JSON.stringify({
        model: 'openjev',
        answers: {
          team: { type: 'choice', choice: 'billing', probabilities: { billing: 0.94, sales: 0.06 }, confidence: 0.85 },
          severity: { type: 'score', score: 1.6, legend: { 0: 'None', 1: 'Mild', 2: 'Serious' }, probabilities: { 0: 0.05, 1: 0.3, 2: 0.65 }, confidence: 0.78 },
          urgent: { type: 'noul', noul: 0.92 },
        },
        usage: { input_tokens: 120, output_tokens: 8 },
      }),
    );

    assert.deepEqual(response.answers.team, {
      type: 'choice',
      choice: 'billing',
      probabilities: { billing: 0.94, sales: 0.06 },
      confidence: 0.85,
    });
    assert.equal(response.answers.severity.score, 1.6);
    assert.equal(response.answers.severity.legend['2'], 'Serious');
    assert.deepEqual(response.answers.urgent, { type: 'noul', noul: 0.92 });
    assert.deepEqual(response.usage, { input_tokens: 120, output_tokens: 8 });
  });

  it('rejects a 2xx body that is not a JSON object', () => {
    assert.throws(() => parseSystemOneResponse('<html>gateway</html>'), error => error.code === 'malformed_response');
    assert.throws(() => parseSystemOneResponse(''), error => error.code === 'malformed_response');
  });

  it('rejects a body with no answers object', () => {
    assert.throws(
      () => parseSystemOneResponse(JSON.stringify({ model: 'openjev' })),
      error => error.code === 'malformed_response' && /answers/.test(error.message),
    );
  });

  it('rejects an unknown answer type instead of guessing', () => {
    assert.throws(
      () => parseSystemOneResponse(JSON.stringify({ answers: { q: { type: 'ranking', order: [] } } })),
      error => error.code === 'malformed_response' && /unknown answer type/.test(error.message),
    );
  });

  it('rejects a choice answer with no probabilities or confidence', () => {
    assert.throws(
      () => parseSystemOneResponse(JSON.stringify({ answers: { q: { type: 'choice', choice: 'a' } } })),
      error => error.code === 'malformed_response' && /probabilities/.test(error.message),
    );
    assert.throws(
      () => parseSystemOneResponse(JSON.stringify({ answers: { q: { type: 'choice', choice: 'a', probabilities: { a: 1 } } } })),
      error => error.code === 'malformed_response' && /confidence/.test(error.message),
    );
  });

  it('rejects a noul probability outside 0..1', () => {
    assert.throws(
      () => parseSystemOneResponse(JSON.stringify({ answers: { q: { type: 'noul', noul: 92 } } })),
      error => error.code === 'malformed_response',
    );
  });

  it('reports a question the service left unanswered', async () => {
    mock.respondWith({ status: 200, body: answerBody({ verdict: { type: 'noul', noul: 0.4 } }) });
    const client = makeClient();

    await assert.rejects(
      client.systemOne({
        state: 'x',
        questions: { verdict: { type: 'noul', instructions: 'a?' }, other: { type: 'noul', instructions: 'b?' } },
      }),
      error => error.code === 'malformed_response' && /"other"/.test(error.message),
    );
  });

  it('treats an id like __proto__ as an ordinary label', async () => {
    const parsed = parseSystemOneResponse(
      JSON.stringify({ answers: { ['__proto__']: { type: 'noul', noul: 0.3 } } }),
    );
    assert.equal(Object.hasOwn(parsed.answers, '__proto__'), true);
    assert.equal(parsed.answers['__proto__'].noul, 0.3);
    assert.equal(Object.getPrototypeOf(parsed.answers), Object.prototype);

    mock.respondWith({ status: 200, body: answerBody({ something_else: { type: 'noul', noul: 0.4 } }) });
    await assert.rejects(
      makeClient().systemOne({ state: 'x', questions: { ['__proto__']: { type: 'noul', instructions: 'a?' } } }),
      error => error.code === 'malformed_response' && /__proto__/.test(error.message),
    );
  });
});

describe('parseRetryAfter', () => {
  it('reads seconds, as OpenJEV sends them', () => {
    assert.equal(parseRetryAfter('3'), 3_000);
    assert.equal(parseRetryAfter('0'), 0);
    assert.equal(parseRetryAfter(' 12 '), 12_000);
  });

  it('accepts an HTTP date and rejects nonsense', () => {
    const now = Date.UTC(2026, 0, 1, 0, 0, 0);
    assert.equal(parseRetryAfter(new Date(now + 5_000).toUTCString(), now), 5_000);
    assert.equal(parseRetryAfter('soon'), undefined);
    assert.equal(parseRetryAfter(null), undefined);
  });
});
