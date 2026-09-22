/**
 * The package version, read from `package.json` at runtime.
 *
 * Hardcoding it here would let the version reported to MCP clients drift from
 * the published manifest after a bump, which is exactly when the number matters.
 */

import { createRequire } from 'node:module';

function readVersion(): string {
  try {
    // `dist/` sits one level below the package root, in this repo and when installed.
    const manifest = createRequire(import.meta.url)('../package.json') as { version?: unknown };
    return typeof manifest.version === 'string' ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = readVersion();
