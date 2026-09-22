/**
 * Environment configuration for the server process.
 *
 * The API key lives here and never reaches a client: this process is the
 * server-side boundary the OpenJEV docs require. Every value is validated
 * before the transport starts, so a typo fails loudly at launch instead of
 * surfacing as a confusing tool error later.
 */

export interface ServerConfig {
  apiKey: string;
  baseUrl: string | undefined;
  timeoutMs: number | undefined;
  maxRetries: number | undefined;
  model: string | undefined;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function readText(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new ConfigError(`${name} is set but empty. Remove it to use the default, or give it a value.`);
  }
  return trimmed;
}

function readInteger(
  env: NodeJS.ProcessEnv,
  name: string,
  bounds: { min: number; max: number },
): number | undefined {
  const text = readText(env, name);
  if (text === undefined) return undefined;
  if (!/^-?\d+$/.test(text)) {
    throw new ConfigError(`${name} must be a whole number, but it is "${text}".`);
  }
  const value = Number(text);
  if (value < bounds.min || value > bounds.max) {
    throw new ConfigError(`${name} must be between ${bounds.min} and ${bounds.max}, but it is ${value}.`);
  }
  return value;
}

function readBaseUrl(env: NodeJS.ProcessEnv): string | undefined {
  const text = readText(env, 'OPENJEV_BASE_URL');
  if (text === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ConfigError(`OPENJEV_BASE_URL must be an absolute URL such as https://api.openjev.sh, but it is "${text}".`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ConfigError(`OPENJEV_BASE_URL must use http or https, but it is "${text}".`);
  }
  return text.replace(/\/+$/, '');
}

/** Read and validate configuration. Throws `ConfigError` on any problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const apiKey = readText(env, 'OPENJEV_API_KEY');
  if (apiKey === undefined) {
    throw new ConfigError(
      [
        'OPENJEV_API_KEY is not set, so no Jev judgment can be requested.',
        'Create a key at https://openjev.sh/dashboard and add it to this server\'s environment:',
        '  "env": { "OPENJEV_API_KEY": "your-key" }',
      ].join('\n'),
    );
  }

  return {
    apiKey,
    baseUrl: readBaseUrl(env),
    timeoutMs: readInteger(env, 'OPENJEV_TIMEOUT_MS', { min: 1_000, max: 600_000 }),
    maxRetries: readInteger(env, 'OPENJEV_MAX_RETRIES', { min: 0, max: 10 }),
    model: readText(env, 'OPENJEV_MODEL'),
  };
}
