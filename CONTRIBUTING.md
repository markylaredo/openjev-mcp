# Contributing

Thanks for helping. Issues and pull requests are welcome.

## Setup

```bash
git clone https://github.com/markylaredo/openjev-mcp.git
cd openjev-mcp
npm ci
npm test
```

The test suite needs **no API key and no network**: a mock OpenJEV drives the client
and tool paths, and one test spawns `dist/index.js` over stdio. Every PR must keep it
green on Node 20, 22, and 24 (CI runs all three).

To try your build in a real client, point the client at your checkout:

```json
{ "command": "node", "args": ["/absolute/path/to/openjev-mcp/dist/index.js"],
  "env": { "OPENJEV_API_KEY": "..." } }
```

`npm link` puts `openjev-mcp` on your PATH pointing at this directory, so a rebuild is
enough between runs.

## Ground rules

- **stdout is the protocol.** Anything human-facing goes to stderr.
- **Tool descriptions are documentation for agents.** If you change behavior, change the
  description in `src/tools.ts` and the README together.
- **Local validation mirrors the documented API rules**, not stricter ones. Cite the
  OpenJEV docs when adding a rule.
- Add a test for every bug fix and every new rule.
- Add an entry under `## [Unreleased]` in `CHANGELOG.md`.

## Releasing (maintainers)

1. Bump `version` in `package.json` **and** both versions in `server.json`
   (`node scripts/check-versions.mjs` verifies they agree).
2. Move the `Unreleased` changelog entries under the new version.
3. Create a GitHub release tagged `v<version>`. The release workflow publishes to npm
   and the MCP Registry.
