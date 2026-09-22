# Production guide

Deployment and operation of `openjev-mcp` in a shared, business-critical, or regulated
setting: credential handling, latency and cost budgets, data governance, and incident
response.

| | |
| --- | --- |
| **Audience** | Operators who deploy, configure, or support `openjev-mcp` |
| **Applies to** | `openjev-mcp` 0.1.1 |
| **Not covered** | Server internals and development practice — see [`../README.md`](../README.md) |

All figures below are shipped defaults or measured results. Capabilities the server does
not provide are listed in [§12](#12-unsupported-capabilities) rather than implied.

**Contents** — [1 Scope](#1-scope) · [2 Clients](#2-client-compatibility) ·
[3 Credentials](#3-credential-management) · [4 Latency](#4-latency-and-timeout-budget) ·
[5 Concurrency](#5-concurrency-and-rate-limiting) · [6 Cost](#6-cost-model) ·
[7 Data](#7-data-governance) · [8 Observability](#8-observability) ·
[9 Upgrade](#9-upgrade-and-rollback) · [10 Runbook](#10-incident-runbook) ·
[11 Checklist](#11-pre-deployment-checklist) · [12 Limits](#12-unsupported-capabilities)

---

## 1. Scope

### 1.1 Supported deployment model

A single operator, or a team in which each member runs their own client, on a machine
that holds the API key in its process environment. The server is spawned per client
session over stdio and exits with that session.

### 1.2 Unsupported deployment model

A shared, multi-tenant service. The package provides no HTTP transport, no authentication
of its own, and no per-tenant credential handling. A networked deployment requires an
authenticated proxy in front of `api.openjev.sh`; that is a separate design, not a
configuration of this one.

## 2. Client compatibility

`openjev-mcp` is built and verified against **DeepSeek Harness**, which is the reference
client and the deployment described in [§2.1](#21-deepseek-harness-reference-client). It
speaks standard MCP over stdio, so any MCP-capable client can run it — the only
client-specific element is where the configuration is written.

| Client | Configuration |
| --- | --- |
| DeepSeek Harness | Profile patch layer (YAML) — see below |
| Claude Desktop, Claude Code, Cursor | `mcpServers` block in the client's JSON config |

Tool names are namespaced by the client, not by this server: DeepSeek Harness exposes them
as `mcp__openjev__jev_ask`, `mcp__openjev__jev_choice`, `mcp__openjev__jev_score`, and
`mcp__openjev__jev_noul`.

### 2.1 DeepSeek Harness (reference client)

Add one entry to the profile patch layer at `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- insert:
    - id: mcp-openjev
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: openjev
        transport: stdio
        command: openjev-mcp
        env:
          OPENJEV_API_KEY: !!js process.env.OPENJEV_API_KEY
        toolCallTimeoutMs: 120000
```

Two requirements are easy to miss:

- **The key must be named in `env`.** The harness passes MCP children a scrubbed
  environment with credential-shaped names removed, so the variable reaches the server
  only because this entry forwards it. `OPENJEV_API_KEY` must therefore exist in the
  harness process, which it does when set in `~/.dsh/.env` ([§3](#3-credential-management)).
- **`toolCallTimeoutMs` must exceed the server's retry budget**
  ([§4](#4-latency-and-timeout-budget)). The 60 s default aborts the third attempt.

The harness reads its environment at startup. A change to `~/.dsh/.env` takes effect only
after a harness restart, and the profile patch layer hot-reloads without one.

## 3. Credential management

The API key is the entire security boundary. It is a server-side secret: it must never
appear in a tool argument, a prompt, a client bundle, or a repository.

For placing a key for the first time, and for the configurations that silently fail to
deliver it, see [Where the API key goes](api-key.md). This section covers the operational
requirements that follow.

### 3.1 Storage

| Deployment | Location |
| --- | --- |
| DeepSeek Harness | `~/.dsh/.env`, forwarded by the profile entry's `env` block |
| Other MCP clients | the `env` block of the client's configuration |
| Local runs and diagnostics | an exported variable, or `--env-file=<path>` **preceding** the script name |

Requirements:

1. File mode `600`, owned by the operator account. A world-readable key file is a finding.
2. Absent from version control. Keep it outside the repository, or in a gitignored path.
3. One canonical copy per machine where practical; every additional copy is another
   artifact to rotate.

### 3.2 Rotation

1. Issue the replacement key at <https://openjev.sh/dashboard>.
2. Update the canonical file — for the harness, `~/.dsh/.env`.
3. Restart the harness. It snapshots its environment at startup, so a file edit alone
   leaves the running process on the previous key.
4. Verify: `openjev-mcp --check` exits `0` ([§8](#8-observability)).
5. Revoke the previous key.

### 3.3 Conditions that defeat rotation

Two configuration conditions cause rotation to appear ineffective:

- **An exported variable takes precedence over every file.** The harness materializes
  `.env` values without replacing inherited ones. If `OPENJEV_API_KEY` is exported from a
  shell profile, that value wins over `~/.dsh/.env` indefinitely. Remove or update the
  export.
- **`args: ["--env-file=…"]` has no effect when `command` is `openjev-mcp`.** Node
  validates the flag in that position but does not load it, so the server starts without
  a key and fails on first use. Use the `env` block, or `command: node` with the flag
  before the script path.

## 4. Latency and timeout budget

The client's per-call timeout must exceed the server's worst case, or it will abort a
retry that is still in progress and report a timeout for a call that would have completed.

| Component | Default | Worst case |
| --- | --- | --- |
| Per-attempt timeout | `OPENJEV_TIMEOUT_MS=30000` | 30 s |
| Attempts | `1 + OPENJEV_MAX_RETRIES=2` | 3 |
| Backoff between attempts | 500 ms base, doubling, 8 s cap, ±10 % jitter | 1.35–1.65 s |
| **End-to-end** | | **~92 s** |

Configure the client above that figure — `toolCallTimeoutMs: 120000` in DeepSeek Harness.

Retries apply to `429`, `5xx`, timeouts, and network failures only. Authentication (`401`)
and request validation (`422`) failures are returned immediately, since repetition cannot
succeed. A `Retry-After` longer than 15 s is returned to the caller rather than waited
out, bounding the worst case.

Tuning:

| Objective | Setting |
| --- | --- |
| Tolerate a slow service | Raise `OPENJEV_TIMEOUT_MS`, and raise the client timeout to match |
| Fail fast for interactive use | `OPENJEV_MAX_RETRIES=0` — every error is returned immediately |
| Absorb transient failures in batch work | Keep the default retries |

## 5. Concurrency and rate limiting

Rate limits apply **per API key**, and every client session spawns an independent server
process. Ten sessions sharing one key are ten processes against one limit, and no process
can observe the others' traffic.

- **Batch rather than fan out.** One `jev_ask` carrying five questions is one request;
  five parallel single-question calls are five. The information is identical.
- **Do not parallelise tool calls** whose questions share a context.
- **Treat `429` as backpressure.** The server honors `Retry-After` up to 15 s; beyond that
  it returns `rate_limited` with `retry_after_ms` for the caller to schedule.
- **Unlimited access does not imply unlimited concurrency.** The service documents the
  distinction explicitly.

## 6. Cost model

Every response carries `usage.input_tokens` and `usage.output_tokens` when the service
reports them. These are token counts, not currency and not a remaining quota; account
usage is shown in the OpenJEV dashboard.

| Call | Tokens |
| --- | --- |
| `jev_noul` — one yes/no question | 299 in / 21 out |
| `jev_choice` — four options | 375 in / 49 out |
| `jev_ask` — two questions | 456 in / 70 out |
| `jev_ask` — three questions | 562 in / 84 out |
| `openjev-mcp --check` | 316 in / 32 out |

Cost is driven by instruction and criteria text, which is paid per call, and is therefore
materially lower when questions are batched. Large `state` payloads, lengthy criterion
descriptions, and long option lists each add to the total. Measure representative requests
before committing to a budget.

## 7. Data governance

**All content placed in `state` is transmitted to and processed by TypeSafe's hosted
service.** This is the intended operation of the API. It determines what may be submitted.

- **Classify `state` as third-party disclosure.** In a utility or other regulated domain,
  member names, account numbers, addresses, meter identifiers, and payment references are
  personal data.
- **Minimise.** Submit the message and the two or three fields the judgment requires, not
  the full account record.
- **Gate before forwarding.** The OpenJEV use-case library provides a `noul` question that
  detects personal or payment data, allowing redaction or review before a substantive
  call. It is inexpensive relative to the call it protects.
- **No server-side retention.** The server holds no database, cache, queue, or files.
- **Log hygiene.** The process writes lifecycle messages only — `openjev-mcp ready: POST
  <endpoint>`, shutdown notices, and startup failures. It does not log `state`, request
  bodies, the API key, or response payloads. This property is verified against `src/`;
  preserve it in any modification.
- **Error payloads.** A rejected request returns the service's response body to the client
  so that `422` failures can be corrected. That text may echo part of the request; it is
  returned to the client, not written to a log.

## 8. Observability

The server exposes no metrics endpoint. The available signals are:

| Signal | Content |
| --- | --- |
| stderr | `openjev-mcp ready: POST <endpoint>` at startup, `stopping on <signal>` at shutdown, and a specific reason on failed startup |
| `openjev-mcp --check` | One small judgment; exit `0` healthy, `1` key rejected, `2` configuration missing |
| Tool errors | Error code, HTTP status where applicable, `retryable` flag, and a next step |
| `usage` | Token counts per call, for attributing spend |

`--check` is suitable as a readiness probe or post-deployment smoke test. It consumes one
call (~316 in / 32 out tokens).

Alerting guidance: page on `auth`, and on `rate_limited` that persists after load
reduction. `aborted` indicates a user cancelled a request and requires no action.

## 9. Upgrade and rollback

A global install is a **copy** of the package, not a link to the source directory.
Modifying the source does not affect the running server until the package is rebuilt and
reinstalled.

Upgrade:

```bash
cd /home/mark/projects/openjev-mcp
npm ci && npm test
npm pack --cache ./.npm-cache
npm install -g ./openjev-mcp-*.tgz
```

The client must then be restarted so that it spawns the new process; an MCP client keeps
the server it started. Clients that hot-reload their MCP configuration, including
DeepSeek Harness, pick the change up from the configuration or the restart.

Retain the previous tarball. Rollback is a reinstall:

```bash
npm install -g ./openjev-mcp-<previous-version>.tgz
```

Post-upgrade verification, in order:

1. `openjev-mcp --help` — the binary on `PATH` is the new build.
2. `openjev-mcp --check` — credentials and endpoint still function.
3. `npm test` — 79 tests, requiring neither network access nor a key.
4. One real tool call through the client — the only check that exercises the full chain.

## 10. Incident runbook

| Symptom | Cause | Action |
| --- | --- | --- |
| `OPENJEV_API_KEY is not set`, exit `2` | Key absent from the process environment | Set it in the client's `env` block. A terminal reading `.env` is not sufficient |
| Tool error `auth` (HTTP 401/403) | Key missing, disabled, or revoked | Correct the key and restart the client. Not retried by design |
| Tool error `invalid_request` (HTTP 422) | The service rejected the request body | Read the attached detail. Repetition without a change fails identically |
| Tool error `rate_limited` (HTTP 429) | Key limit reached | Batch calls, reduce parallelism, honor `retry_after_ms` |
| Tool error `unavailable` (HTTP 5xx) | Service unavailable or throttling | Retried automatically; if sustained, check <https://openjev.sh> |
| Tool error `timeout` | Attempt exceeded `OPENJEV_TIMEOUT_MS` | Raise it, and raise the client timeout above ~92 s |
| Tool error `network` | DNS, egress, or an incorrect `OPENJEV_BASE_URL` | Verify network access and the configured endpoint |
| Tool error `malformed_response` | Response off-contract | Treat the judgment as unavailable. Do not infer a value; report the occurrence |
| "Request rejected locally" | Local rules rejected the request before transmission | Correct the reported path. No call was spent |
| Client lists no `mcp__openjev__*` tools | Server failed to start, or the client was not restarted | Inspect the client's MCP log; `openjev-mcp --check` separates credential faults from client faults |
| Every call fails at the client's timeout value | Client timeout below the server's retry budget | Raise `toolCallTimeoutMs` above ~92 s |
| Failure after editing `~/.dsh/.env` | The harness caches its environment at startup | Restart the harness |

## 11. Pre-deployment checklist

- [ ] `OPENJEV_API_KEY` present, mode `600`, absent from all repositories
- [ ] `openjev-mcp --check` exits `0` on the target machine
- [ ] Client per-call timeout configured above ~92 s
- [ ] Client restarted since the last configuration or credential change
- [ ] A real tool call verified through the client, not only `--check`
- [ ] `state` payloads reviewed for personal data; redaction or a detection gate in place
- [ ] Rotation runbook known to the on-call operator; previous tarball retained
- [ ] `auth` failures and sustained `rate_limited` routed to a human, not only to logs

## 12. Unsupported capabilities

Documented so that they are not assumed:

- **No HTTP transport.** stdio only; the process never opens a listening socket.
- **No authentication or multi-tenancy.** One key per environment.
- **No metrics, tracing, or audit trail.** Only the lifecycle log lines in
  [§8](#8-observability).
- **No caching or deduplication.** Identical requests consume identical tokens.
- **No persistence.** Nothing survives the process.
- **No streaming.** A judgment is returned complete or not at all.
- **No image, audio, or file input.** The API accepts text and JSON only.
