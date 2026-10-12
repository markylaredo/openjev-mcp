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

1. Run `npm run release -- <version>`, or `patch`, `minor`, or `major`. It sets the
   version in `package.json`, `package-lock.json`, and `server.json`, moves the
   `Unreleased` changelog entries under it, and prints the commit command.
2. Commit, push, and open a pull request. CI checks that every version agrees.
3. Merge it. The release workflow sees a version on `main` that is not out yet,
   publishes it to npm and the MCP Registry, then creates the `v<version>` tag and the
   GitHub release from its changelog section. There is no release to create by hand.

If a release fails part way, re-run the workflow, or start it from the Actions tab: it
skips whatever already succeeded.
