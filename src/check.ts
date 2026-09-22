/**
 * `--check`: one live round trip, reported for a human.
 *
 * A stdio server started by hand cannot show that it works — it prints "ready"
 * and waits for a client that never comes, so a bad key stays invisible until
 * someone wires up a client and calls a tool. This mode spends one small
 * judgment to prove the whole path instead: configuration, network, credentials,
 * the response contract, and the judgment itself.
 */

import { describeDetails, OpenJevClient } from './client.js';
import { isOpenJevError } from './errors.js';

/** The smallest question worth asking: one word, one binary judgment. */
const PROBE_STATE = 'ok';

/**
 * Run one live judgment and report it.
 *
 * @param client - the configured client, so retries and validation behave exactly as in a tool call.
 * @param write - sink for the report (stdout in the CLI).
 * @returns whether the check passed; the caller turns that into an exit code.
 */
export async function runCheck(client: OpenJevClient, write: (line: string) => void): Promise<boolean> {
  write(`openjev-mcp check: POST ${client.endpoint}`);

  try {
    const response = await client.systemOne({
      state: PROBE_STATE,
      questions: {
        echoed: {
          type: 'choice',
          instructions: 'Which word is the state?',
          criteria: { ok: 'The state is the single word "ok"', other: 'Anything else' },
        },
      },
    });

    const answer = response.answers['echoed'];
    const detail = answer?.type === 'choice' ? `"${answer.choice}" (confidence ${answer.confidence.toFixed(2)})` : 'unexpected shape';
    if (response.model !== undefined) write(`  model    : ${response.model}`);
    write(`  judgment : ${detail}`);
    if (response.usage !== undefined) {
      write(`  usage    : ${response.usage.input_tokens ?? '?'} in / ${response.usage.output_tokens ?? '?'} out tokens`);
    }
    write('  OK: the API key works and a judgment came back.');
    return true;
  } catch (error) {
    if (isOpenJevError(error)) {
      write(`  FAILED: ${error.describe()}`);
      const details = describeDetails(error);
      if (details !== undefined) write(`  details  : ${details}`);
      write(`  ${nextStepFor(error.code)}`);
      return false;
    }
    const message = error instanceof Error ? error.message : String(error);
    write(`  FAILED: unexpected error: ${message}`);
    return false;
  }
}

function nextStepFor(code: string): string {
  switch (code) {
    case 'auth':
      return 'Fix OPENJEV_API_KEY (or OPENJEV_BASE_URL if this is not the endpoint you meant).';
    case 'network':
      return 'Check network access and OPENJEV_BASE_URL.';
    case 'timeout':
      return 'Raise OPENJEV_TIMEOUT_MS.';
    case 'rate_limited':
    case 'unavailable':
      return 'The service is throttling or down; try again shortly.';
    default:
      return 'The service answered, but not with a usable judgment.';
  }
}
