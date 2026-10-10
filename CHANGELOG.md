# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

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
