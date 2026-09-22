#!/usr/bin/env node
/**
 * stdio entry point.
 *
 * stdout carries JSON-RPC and nothing else: every human-facing message goes to
 * stderr, because a stray write to stdout corrupts the protocol stream. The API
 * key lives in this process's environment and never leaves it.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { runCheck } from './check.js';
import { OpenJevClient } from './client.js';
import { ConfigError, loadConfig } from './config.js';
import { createServer } from './server.js';

const USAGE = [
  'openjev-mcp — MCP server for Jev (TypeSafe System One) through the OpenJEV API.',
  '',
  'Normally this is spawned by an MCP client, which supplies OPENJEV_API_KEY in its',
  'environment; it then speaks JSON-RPC over stdin/stdout and writes logs to stderr.',
  '',
  'Usage:',
  '  openjev-mcp            serve stdio (what a client runs)',
  '  openjev-mcp --check    spend one small judgment to prove the key and endpoint work',
  '  openjev-mcp --help     this text',
  '',
  'Environment: OPENJEV_API_KEY (required), OPENJEV_BASE_URL, OPENJEV_TIMEOUT_MS,',
  '             OPENJEV_MAX_RETRIES, OPENJEV_MODEL — see .env.sample.',
].join('\n');

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig();

  const client = new OpenJevClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeoutMs: config.timeoutMs,
    maxRetries: config.maxRetries,
    defaultModel: config.model,
  });

  if (argv.includes('--check')) {
    // A human-facing report, so stdout is the right place; there is no protocol here.
    const ok = await runCheck(client, line => console.log(line));
    process.exitCode = ok ? 0 : 1;
    return;
  }

  const server = createServer({ client });
  await server.connect(new StdioServerTransport());

  console.error(`openjev-mcp ready: POST ${client.endpoint}`);

  const shutdown = (signal: NodeJS.Signals): void => {
    console.error(`openjev-mcp stopping on ${signal}`);
    void server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    console.error(`openjev-mcp: not started.\n${error.message}`);
    process.exit(2);
  }
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`openjev-mcp: failed to start.\n${message}`);
  process.exit(1);
});
