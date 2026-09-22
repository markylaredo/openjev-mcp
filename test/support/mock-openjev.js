/**
 * A stand-in for the OpenJEV API.
 *
 * Tests drive it with a responder function, so a test can assert the exact
 * request that left the client and decide what comes back — a documented
 * response, a failure status, a retry, or silence.
 */

import { createServer } from 'node:http';

/**
 * @param {object} [options]
 * @param {(request: object, callNumber: number) => object | Promise<object>} [options.responder]
 * @returns {Promise<object>} a running mock with helpers to inspect and answer
 */
export async function startMockOpenJev(options = {}) {
  /** @type {Array<object>} every request received, in order */
  const requests = [];
  let responder = options.responder ?? (() => ({ status: 200, body: { answers: {} } }));

  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        body = undefined;
      }
      requests.push({ method: req.method, url: req.url, headers: req.headers, raw, body });

      const reply = await responder(requests[requests.length - 1], requests.length);
      if (reply.delayMs) await new Promise(resolve => setTimeout(resolve, reply.delayMs));
      if (reply.hang) return;
      res.writeHead(reply.status ?? 200, {
        'content-type': 'application/json',
        ...(reply.headers ?? {}),
      });
      res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    /** Base URL to hand the client; the client appends `/v1/systemone`. */
    url: `http://127.0.0.1:${port}`,
    endpoint: `http://127.0.0.1:${port}/v1/systemone`,
    requests,
    /** Replace the responder. */
    setResponder(next) {
      responder = next;
    },
    /** Answer successive calls with these replies; the last one repeats forever. */
    respondWith(...replies) {
      let index = 0;
      responder = () => replies[Math.min(index++, replies.length - 1)];
    },
    async close() {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

/** A well-formed response for one question, shaped per primitive. */
export function answerBody(answers, extra = {}) {
  return { model: 'openjev', answers, usage: { input_tokens: 100, output_tokens: 5 }, ...extra };
}
