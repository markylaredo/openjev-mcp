/**
 * Environment configuration: a misconfigured server must fail at launch with a
 * message that says how to fix it, not degrade into confusing tool errors.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ConfigError, loadConfig } from '../dist/config.js';

function expectConfigError(env, pattern) {
  assert.throws(
    () => loadConfig(env),
    error => {
      assert.ok(error instanceof ConfigError, `expected ConfigError, got ${error?.name}`);
      assert.match(error.message, pattern);
      return true;
    },
  );
}

describe('loadConfig', () => {
  it('requires an API key and says where to get one', () => {
    expectConfigError({}, /OPENJEV_API_KEY is not set/);
    expectConfigError({ OPENJEV_API_KEY: '' }, /set but empty/);
    expectConfigError({ OPENJEV_API_KEY: '   ' }, /set but empty/);
    try {
      loadConfig({});
    } catch (error) {
      assert.match(error.message, /https:\/\/openjev\.sh\/dashboard/);
    }
  });

  it('defaults every optional value', () => {
    assert.deepEqual(loadConfig({ OPENJEV_API_KEY: 'k' }), {
      apiKey: 'k',
      baseUrl: undefined,
      timeoutMs: undefined,
      maxRetries: undefined,
      model: undefined,
    });
  });

  it('reads and trims the configured values', () => {
    const config = loadConfig({
      OPENJEV_API_KEY: '  secret  ',
      OPENJEV_BASE_URL: 'https://api.example.test/',
      OPENJEV_TIMEOUT_MS: '5000',
      OPENJEV_MAX_RETRIES: '0',
      OPENJEV_MODEL: 'openjev',
    });
    assert.deepEqual(config, {
      apiKey: 'secret',
      baseUrl: 'https://api.example.test',
      timeoutMs: 5_000,
      maxRetries: 0,
      model: 'openjev',
    });
  });

  it('rejects a base URL that is not an absolute http(s) URL', () => {
    expectConfigError({ OPENJEV_API_KEY: 'k', OPENJEV_BASE_URL: 'api.openjev.sh' }, /must be an absolute URL/);
    expectConfigError({ OPENJEV_API_KEY: 'k', OPENJEV_BASE_URL: 'ftp://api.openjev.sh' }, /must use http or https/);
  });

  it('rejects a non-numeric or out-of-range number', () => {
    expectConfigError({ OPENJEV_API_KEY: 'k', OPENJEV_TIMEOUT_MS: 'soon' }, /must be a whole number/);
    expectConfigError({ OPENJEV_API_KEY: 'k', OPENJEV_TIMEOUT_MS: '10' }, /between 1000 and 600000/);
    expectConfigError({ OPENJEV_API_KEY: 'k', OPENJEV_MAX_RETRIES: '-1' }, /between 0 and 10/);
    expectConfigError({ OPENJEV_API_KEY: 'k', OPENJEV_MAX_RETRIES: '99' }, /between 0 and 10/);
  });
});
