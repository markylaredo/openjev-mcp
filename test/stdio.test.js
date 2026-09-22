/**
 * The packaged entry point, spawned the way an MCP client spawns it.
 *
 * Two things matter beyond the tool behaviour already covered elsewhere: stdout
 * must carry the protocol and nothing else, and a misconfigured process must
 * exit with a message rather than look like a broken server.
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { answerBody, startMockOpenJev } from './support/mock-openjev.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entry = path.join(root, 'dist', 'index.js');

/** The parent environment without any OPENJEV_* value, so each test is explicit. */
function baseEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith('OPENJEV_')) env[key] = value;
  }
  return { ...env, ...extra };
}

function runToCompletion(env, stdin = '', argv = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...argv], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
    if (stdin) child.stdin.write(stdin);
    child.stdin.end();
  });
}

/** @type {Awaited<ReturnType<typeof startMockOpenJev>>} */
let mock;

before(async () => {
  mock = await startMockOpenJev();
});

after(async () => {
  await mock.close();
});

describe('a configured stdio server', () => {
  it('answers a raw JSON-RPC initialize on stdout, and logs only to stderr', async () => {
    const request = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw-probe', version: '0.0.0' },
      },
    };

    const { code, stdout, stderr } = await runToCompletion(
      baseEnv({ OPENJEV_API_KEY: 'test-key', OPENJEV_BASE_URL: mock.url }),
      `${JSON.stringify(request)}\n`,
    );

    assert.equal(code, 0);
    const lines = stdout.split('\n').filter(line => line.trim().length > 0);
    assert.ok(lines.length >= 1, 'the server must answer the handshake');
    for (const line of lines) {
      // Any stray log line on stdout would fail here, which is the point.
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0');
    }
    const response = JSON.parse(lines[0]);
    assert.equal(response.id, 1);
    assert.equal(response.result.serverInfo.name, 'openjev');
    assert.match(response.result.instructions, /calibrated judgments/);

    assert.match(stderr, /openjev-mcp ready: POST .*\/v1\/systemone/);
  });

  it('serves tools to a real MCP client over stdio', async () => {
    mock.respondWith({ status: 200, body: answerBody({ noul: { type: 'noul', noul: 0.88 } }) });

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: baseEnv({ OPENJEV_API_KEY: 'test-key', OPENJEV_BASE_URL: mock.url }),
      stderr: 'pipe',
    });
    const client = new Client({ name: 'stdio-test', version: '0.0.0' });

    try {
      await client.connect(transport);

      assert.equal(client.getServerVersion().name, 'openjev');

      const { tools } = await client.listTools();
      assert.equal(tools.length, 4);

      const result = await client.callTool({
        name: 'jev_noul',
        arguments: { state: 'Please help ASAP.', instructions: 'Does this message convey urgency?' },
      });

      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.answer.noul, 0.88);
      assert.equal(mock.requests.at(-1).headers.authorization, 'Bearer test-key');
    } finally {
      await client.close();
    }
  });
});

describe('self-check mode', () => {
  it('proves the key and endpoint work, and exits 0', async () => {
    mock.respondWith({
      status: 200,
      body: answerBody({ echoed: { type: 'choice', choice: 'ok', probabilities: { ok: 1, other: 0 }, confidence: 1 } }),
    });

    const { code, stdout, stderr } = await runToCompletion(
      baseEnv({ OPENJEV_API_KEY: 'test-key', OPENJEV_BASE_URL: mock.url }),
      '',
      ['--check'],
    );

    assert.equal(code, 0);
    assert.match(stdout, /openjev-mcp check: POST .*\/v1\/systemone/);
    assert.match(stdout, /judgment : "ok" \(confidence 1\.00\)/);
    assert.match(stdout, /usage {4}: 100 in \/ 5 out tokens/);
    assert.match(stdout, /OK: the API key works/);
    assert.equal(stderr, '', 'a check run must not start the stdio server');

    const sent = mock.requests.at(-1).body;
    assert.equal(sent.state, 'ok');
    assert.deepEqual(Object.keys(sent.questions), ['echoed']);
  });

  it('reports a rejected key and exits non-zero', async () => {
    mock.respondWith({ status: 401, body: { error: 'Missing, disabled or invalid API key.' } });

    const { code, stdout } = await runToCompletion(
      baseEnv({ OPENJEV_API_KEY: 'wrong', OPENJEV_BASE_URL: mock.url }),
      '',
      ['--check'],
    );

    assert.equal(code, 1);
    assert.match(stdout, /FAILED: .*\[auth\]/);
    assert.match(stdout, /Fix OPENJEV_API_KEY/);
    assert.doesNotMatch(stdout, /OK:/);
  });

  it('still refuses to run without a key', async () => {
    const { code, stderr } = await runToCompletion(baseEnv(), '', ['--check']);
    assert.equal(code, 2);
    assert.match(stderr, /OPENJEV_API_KEY is not set/);
  });

  it('explains itself with --help, no key required', async () => {
    const { code, stdout } = await runToCompletion(baseEnv(), '', ['--help']);

    assert.equal(code, 0);
    assert.match(stdout, /openjev-mcp --check/);
    assert.match(stdout, /OPENJEV_API_KEY \(required\)/);
  });
});

describe('a misconfigured stdio server', () => {
  it('exits with a fixable message when the API key is missing', async () => {
    const { code, stdout, stderr } = await runToCompletion(baseEnv());

    assert.equal(code, 2);
    assert.equal(stdout, '', 'nothing may be written to stdout');
    assert.match(stderr, /OPENJEV_API_KEY is not set/);
    assert.match(stderr, /https:\/\/openjev\.sh\/dashboard/);
  });

  it('exits when an environment value cannot be parsed', async () => {
    const { code, stdout, stderr } = await runToCompletion(
      baseEnv({ OPENJEV_API_KEY: 'test-key', OPENJEV_TIMEOUT_MS: 'soon' }),
    );

    assert.equal(code, 2);
    assert.equal(stdout, '');
    assert.match(stderr, /OPENJEV_TIMEOUT_MS must be a whole number/);
  });
});
