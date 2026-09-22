/**
 * The tool surface, exercised over a real MCP connection to an in-process
 * server: what clients see in `tools/list`, what reaches the API, and what a
 * caller gets back on every path — success, local rejection, and API failure.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { answerBody, startMockOpenJev } from './support/mock-openjev.js';
import { connectInProcess, textPayload } from './support/harness.js';

/** @type {Awaited<ReturnType<typeof startMockOpenJev>>} */
let mock;
/** @type {Awaited<ReturnType<typeof connectInProcess>>} */
let mcp;

before(async () => {
  mock = await startMockOpenJev();
  mcp = await connectInProcess({ baseUrl: mock.url });
});

after(async () => {
  await mcp.close();
  await mock.close();
});

beforeEach(() => {
  mock.requests.length = 0;
});

const choiceAnswer = { type: 'choice', choice: 'billing', probabilities: { billing: 0.94, sales: 0.06 }, confidence: 0.85 };

describe('tools/list', () => {
  it('offers the four Jev tools', async () => {
    const { tools } = await mcp.client.listTools();
    assert.deepEqual(
      tools.map(tool => tool.name).sort(),
      ['jev_ask', 'jev_choice', 'jev_noul', 'jev_score'],
    );
  });

  it('describes each tool well enough to choose between them', async () => {
    const { tools } = await mcp.client.listTools();
    for (const tool of tools) {
      assert.ok(tool.description.length > 150, `${tool.name} needs a real description`);
      assert.ok(tool.inputSchema, `${tool.name} needs an input schema`);
      assert.ok(tool.outputSchema, `${tool.name} needs an output schema`);
      assert.equal(tool.annotations?.readOnlyHint, true);
    }
  });

  it('publishes schemas that name the required arguments', async () => {
    const { tools } = await mcp.client.listTools();
    const byName = Object.fromEntries(tools.map(tool => [tool.name, tool]));

    assert.deepEqual(byName.jev_ask.inputSchema.required.sort(), ['questions', 'state']);
    assert.deepEqual([...Object.keys(byName.jev_choice.inputSchema.properties)].sort(), [
      'criteria',
      'instructions',
      'model',
      'question_id',
      'state',
    ]);
    assert.match(byName.jev_choice.inputSchema.properties.state.description, /object of named fields/);
    assert.match(byName.jev_noul.description, /near 0\.5 uncertain/);
  });

  it('tells the client how confidence may be used', async () => {
    const { tools } = await mcp.client.listTools();
    const choice = tools.find(tool => tool.name === 'jev_choice');
    assert.match(choice.description, /not the probability that the selection is correct/);
  });
});

describe('jev_choice', () => {
  it('sends one choice question and returns the selection with its distribution', async () => {
    mock.respondWith({ status: 200, body: answerBody({ choice: choiceAnswer }) });

    const result = await mcp.client.callTool({
      name: 'jev_choice',
      arguments: {
        state: 'My card was charged twice.',
        instructions: 'Which team should handle this?',
        criteria: { billing: 'Payments and refunds', sales: 'New accounts', other: 'Anything else' },
      },
    });

    assert.equal(result.isError, undefined);
    assert.deepEqual(result.structuredContent, {
      question_id: 'choice',
      answer: choiceAnswer,
      model: 'openjev',
      usage: { input_tokens: 100, output_tokens: 5 },
    });
    assert.deepEqual(JSON.parse(textPayload(result)), result.structuredContent);

    const sent = mock.requests[0].body;
    assert.equal(sent.questions.choice.type, 'choice');
    assert.deepEqual(sent.questions.choice.criteria, {
      billing: 'Payments and refunds',
      sales: 'New accounts',
      other: 'Anything else',
    });
  });

  it('turns an array of option names into the wire form', async () => {
    mock.respondWith({ status: 200, body: answerBody({ choice: choiceAnswer }) });

    await mcp.client.callTool({
      name: 'jev_choice',
      arguments: { state: 'x', instructions: 'Which team?', criteria: ['billing', 'sales'] },
    });

    assert.deepEqual(mock.requests[0].body.questions.choice.criteria, { billing: null, sales: null });
  });

  it('uses the caller-supplied question id', async () => {
    mock.respondWith({ status: 200, body: answerBody({ team: choiceAnswer }) });

    const result = await mcp.client.callTool({
      name: 'jev_choice',
      arguments: { state: 'x', instructions: 'Which team?', criteria: ['billing', 'sales'], question_id: 'team' },
    });

    assert.equal(result.structuredContent.question_id, 'team');
    assert.ok(mock.requests[0].body.questions.team);
  });

  it('passes a fallback-option hint through without failing the call', async () => {
    mock.respondWith({ status: 200, body: answerBody({ choice: choiceAnswer }) });

    const result = await mcp.client.callTool({
      name: 'jev_choice',
      arguments: { state: 'x', instructions: 'Which team?', criteria: ['billing', 'sales'] },
    });

    assert.equal(result.structuredContent.hints.length, 1);
    assert.match(result.structuredContent.hints[0], /"other" or "none"/);
  });
});

describe('jev_score and jev_noul', () => {
  it('returns a score with its legend', async () => {
    const scoreAnswer = {
      type: 'score',
      score: 1.6,
      legend: { 0: 'None', 1: 'Mild', 2: 'Serious' },
      probabilities: { 0: 0.05, 1: 0.3, 2: 0.65 },
      confidence: 0.78,
    };
    mock.respondWith({ status: 200, body: answerBody({ score: scoreAnswer }) });

    const result = await mcp.client.callTool({
      name: 'jev_score',
      arguments: { state: 'A prompt injection attempt.', instructions: 'How much harm would complying do?', criteria: ['None', 'Mild', 'Serious'] },
    });

    assert.equal(result.structuredContent.answer.score, 1.6);
    assert.equal(result.structuredContent.answer.legend['2'], 'Serious');
    assert.deepEqual(mock.requests[0].body.questions.score.criteria, ['None', 'Mild', 'Serious']);
  });

  it('returns a probability and no confidence field', async () => {
    mock.respondWith({ status: 200, body: answerBody({ noul: { type: 'noul', noul: 0.92 } }) });

    const result = await mcp.client.callTool({
      name: 'jev_noul',
      arguments: { state: 'Please help ASAP.', instructions: 'Does this message convey urgency?', criteria: { true: 'Time-sensitive', false: 'No urgency' } },
    });

    assert.deepEqual(result.structuredContent.answer, { type: 'noul', noul: 0.92 });
    assert.equal('confidence' in result.structuredContent.answer, false);
    assert.deepEqual(mock.requests[0].body.questions.noul.criteria, { true: 'Time-sensitive', false: 'No urgency' });
  });
});

describe('jev_ask', () => {
  it('asks several independent questions in a single request', async () => {
    mock.respondWith({
      status: 200,
      body: answerBody({
        team: choiceAnswer,
        severity: { type: 'score', score: 1, legend: { 0: 'None', 1: 'Mild' }, probabilities: { 0: 0.5, 1: 0.5 }, confidence: 0.2 },
        urgent: { type: 'noul', noul: 0.92 },
      }),
    });

    const result = await mcp.client.callTool({
      name: 'jev_ask',
      arguments: {
        state: 'My card was charged twice. Please help ASAP.',
        questions: {
          team: { type: 'choice', instructions: 'Which team should handle this?', criteria: { billing: 'Payments', other: null } },
          severity: { type: 'score', instructions: 'How urgent is the request?', criteria: ['No time pressure', 'Immediate action requested'] },
          urgent: { type: 'noul', instructions: 'Does the message convey urgency?' },
        },
      },
    });

    assert.equal(mock.requests.length, 1, 'three questions must cost one call');
    assert.deepEqual(Object.keys(mock.requests[0].body.questions), ['team', 'severity', 'urgent']);
    assert.equal(result.isError, undefined);
    assert.deepEqual(Object.keys(result.structuredContent.answers), ['team', 'severity', 'urgent']);
    assert.equal(result.structuredContent.answers.urgent.noul, 0.92);
    assert.equal(result.structuredContent.usage.input_tokens, 100);
  });
});

describe('requests rejected before the call', () => {
  it('returns every problem and spends no HTTP request', async () => {
    const result = await mcp.client.callTool({
      name: 'jev_ask',
      arguments: {
        state: '',
        questions: { team: { type: 'choice', instructions: 'Which team?', criteria: { only: null } } },
      },
    });

    assert.equal(result.isError, true);
    assert.equal(mock.requests.length, 0, 'a locally invalid request must not cost a call');
    const text = textPayload(result);
    assert.match(text, /questions\.team\.criteria: needs at least 2 options/);
    assert.match(text, /state: must not be empty/);
  });

  it('rejects a noul criteria typo at the schema boundary', async () => {
    const result = await mcp.client.callTool({
      name: 'jev_noul',
      arguments: { state: 'x', instructions: 'Is it urgent?', criteria: { yes: 'sounds urgent' } },
    });

    assert.equal(result.isError, true);
    assert.match(textPayload(result), /Unrecognized key: "yes"/);
    assert.equal(mock.requests.length, 0);
  });

  it('rejects a missing required argument', async () => {
    const result = await mcp.client.callTool({
      name: 'jev_choice',
      arguments: { state: 'x', criteria: ['a', 'b'] },
    });

    assert.equal(result.isError, true);
    assert.match(textPayload(result), /Invalid input at instructions/);
    assert.equal(mock.requests.length, 0);
  });
});

describe('API failures reach the caller as tool errors', () => {
  it('explains an authentication failure and what to do', async () => {
    mock.respondWith({ status: 401, body: { error: 'invalid api key' } });

    const result = await mcp.client.callTool({
      name: 'jev_noul',
      arguments: { state: 'x', instructions: 'Is it urgent?' },
    });

    assert.equal(result.isError, true);
    const text = textPayload(result);
    assert.match(text, /OPENJEV_API_KEY/);
    assert.match(text, /"code":"auth"/);
    assert.equal(result.structuredContent, undefined);
  });

  it('surfaces the server detail for a rejected body', async () => {
    mock.respondWith({ status: 422, body: { error: 'model alias unknown' } });

    const result = await mcp.client.callTool({
      name: 'jev_noul',
      arguments: { state: 'x', instructions: 'Is it urgent?' },
    });

    assert.equal(result.isError, true);
    const text = textPayload(result);
    assert.match(text, /"code":"invalid_request"/);
    assert.match(text, /model alias unknown/);
    assert.match(text, /repeating it unchanged/);
  });

  it('reports the wait when a rate limit outlasts the retry budget', async () => {
    mock.respondWith({ status: 429, headers: { 'retry-after': '600' }, body: { error: 'slow down' } });

    const result = await mcp.client.callTool({
      name: 'jev_noul',
      arguments: { state: 'x', instructions: 'Is it urgent?' },
    });

    assert.equal(result.isError, true);
    assert.match(textPayload(result), /"retry_after_ms":600000/);
  });

  it('does not invent a judgment when the response is off-contract', async () => {
    mock.respondWith({ status: 200, body: { answers: { noul: { type: 'noul', noul: 'high' } } } });

    const result = await mcp.client.callTool({
      name: 'jev_noul',
      arguments: { state: 'x', instructions: 'Is it urgent?' },
    });

    assert.equal(result.isError, true);
    assert.match(textPayload(result), /"code":"malformed_response"/);
  });
});
