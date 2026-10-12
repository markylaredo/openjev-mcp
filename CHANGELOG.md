# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- `jev_batch`: the same questions put to up to 100 items in one tool call, one request
  per item. Answers and errors are keyed by the caller's item ids, and one failed item
  does not sink the rest.
- Batches are paced: `OPENJEV_BATCH_CONCURRENCY` requests in flight (default 4), and a
  `429` pauses new requests for the interval the service asked for and halves the
  concurrency. A batch stops early, keeping its answers and listing the unsent items, on a
  rejected key, a rate limit it cannot wait out, or three failures in a row. It is
  bounded by the single-call worst case (~120 s by default), so existing client timeouts
  cover it, and it reports progress when the client asks for it.
- `examples/`: real DeepSeek Harness transcripts of an electric co-op's help desk, one
  member complaint through `jev_ask` and a morning's queue through `jev_batch`, with the
  tasks and the overlay that recorded them.

### Changed
- `jev_ask` is titled "Ask Jev (several questions)", so it is not mistaken for `jev_batch`.
- The `jev_ask` and `state` descriptions say that a state is judged as one whole and
  point a list of records to `jev_batch`. A recorded agent had packed a whole ticket
  queue into one state and got one blended answer.

## [0.1.2]

### Changed
- Release workflow authenticates to npm with trusted publishing (OIDC) and adds
  provenance from CI only, so a manual `npm publish` from a laptop no longer fails.
- Release workflow builds before publishing, so npm never sees a missing `bin` file.

## [0.1.1]

### Added
- Published to npm: run with `npx -y openjev-mcp`, no clone or build needed.
- `server.json` for the official MCP Registry (`io.github.markylaredo/openjev-mcp`).
- CI on Node 20, 22, and 24; release workflow that publishes to npm and to the MCP
  Registry.
- One-click install links for Cursor and VS Code, and a `claude mcp add` command.

### Changed
- Tool registration carries explicit annotations (read-only, non-destructive, open-world).
- `@modelcontextprotocol/sdk` updated.

## [0.1.0]

- Initial release: `jev_ask`, `jev_choice`, `jev_score`, `jev_noul` over stdio, with
  local request validation, retries, response validation, and `--check`.
