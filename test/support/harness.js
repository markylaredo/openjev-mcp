/**
 * Connect an in-process MCP client to the real server over a linked pair of
 * in-memory transports. No child process, no stdout: this exercises the tool
 * layer, schemas, and output validation exactly as a client would see them.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { OpenJevClient } from '../../dist/client.js';
import { createServer } from '../../dist/server.js';

/**
 * @param {object} options
 * @param {string} options.baseUrl base URL of the mock API
 * @param {Record<string, unknown>} [options.clientOptions] extra client options
 */
export async function connectInProcess({ baseUrl, clientOptions = {} }) {
  const openjev = new OpenJevClient({
    apiKey: 'test-key',
    baseUrl,
    sleepImpl: async () => {},
    retryBaseDelayMs: 1,
    ...clientOptions,
  });
  const server = createServer({ client: openjev });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);

  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);

  return {
    client,
    server,
    openjev,
    async close() {
      await client.close();
      await server.close();
    },
  };
}

/** Parse the JSON payload a tool put in its text content. */
export function textPayload(result) {
  const first = result.content?.[0];
  if (!first || first.type !== 'text') throw new Error('tool result had no text content');
  return first.text;
}
