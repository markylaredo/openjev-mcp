/**
 * Server assembly: one `McpServer` with the Jev tool surface attached.
 *
 * Kept separate from process concerns (env, transport, signals) so the same
 * server can be built in-process by tests.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { OpenJevClient } from './client.js';
import { registerTools } from './tools.js';
import { VERSION } from './version.js';

export const SERVER_NAME = 'openjev';
export const SERVER_VERSION = VERSION;

/**
 * Server-level guidance, sent once at initialization. It says when these tools
 * are worth reaching for, which is the part a per-tool description cannot cover.
 */
const INSTRUCTIONS = [
  'Jev returns calibrated judgments rather than generated text: typed answers and probabilities that code can act on.',
  '',
  'Reach for these tools when a decision needs semantic understanding that ordinary code cannot express — routing, ranking, flagging, resolving free text to a known value — and keep exact rules, lookups, and arithmetic in code.',
  '',
  'Prefer `jev_ask` when several independent judgments share one context: they are evaluated in a single call against the same state. Use `jev_choice`, `jev_score`, or `jev_noul` for a single judgment.',
  '',
  'Probabilities guide behavior; they are not permission to act. Send a low-confidence answer to a person rather than acting irreversibly on it, and never read `confidence` as the probability of being correct.',
].join('\n');

export interface CreateServerOptions {
  client: OpenJevClient;
  /** Reported to clients during initialization. */
  version?: string | undefined;
}

export function createServer(options: CreateServerOptions): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: options.version ?? SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  registerTools(server, { client: options.client });
  return server;
}
