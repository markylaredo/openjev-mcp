# Where the API key goes

**One rule decides everything:** the server reads `OPENJEV_API_KEY` from the environment
of the process that runs it. It reads no file, searches no directory, and performs no
`.env` discovery.

So the question is never *"where does the `.env` file go?"* — it is **"what launches the
server, and how does that thing set the environment of the process it starts?"** Every
answer below follows from that.

## Decision table

| What launches `openjev-mcp` | Put the key in | Section |
| --- | --- | --- |
| DeepSeek Harness | `~/.dsh/.env`, forwarded by the profile entry's `env:` block | [§1](#1-deepseek-harness) |
| Claude Desktop, Claude Code, Cursor | the `env` block of that client's configuration | [§2](#2-other-mcp-clients) |
| You, in a terminal | an exported variable, or `--env-file` **before** the script name | [§3](#3-running-it-yourself) |
| `npm test` | nowhere — the suite uses a mock API and needs no key | — |
| `openjev-mcp --check` | the same place the real client will use | [§4](#4-verify) |

---

## 1. DeepSeek Harness

Two edits in two different files. **Both are required** — neither works alone.

**a. Put the key in `~/.dsh/.env`:**

```
OPENJEV_API_KEY=oj_live_…
```

File mode `600`. This file is loaded by the harness at startup, not by your shell.

**b. Forward it from the profile entry** in
`~/.dsh/profiles/<profile>/cordis.patch.yml`:

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

**Why both are needed.** The harness loads `~/.dsh/.env` into *its own* process, and then
hands each MCP child a **scrubbed** environment with credential-shaped names removed. The
key reaches the server only because the entry names it explicitly. A key in `~/.dsh/.env`
with no `env:` block in the profile reaches nothing.

**Precedence, highest first:**

```
inherited environment  >  .env where you launched dsh  >  ~/.dsh/.env
```

An exported variable therefore overrides the file permanently — see [§5](#5-what-does-not-work).

**Restart the harness after editing the file.** It snapshots its environment at startup;
editing `~/.dsh/.env` alone changes nothing for a running process. The profile entry
hot-reloads, but the environment does not.

---

## 2. Other MCP clients

The `mcpServers` shape, as used by Claude Desktop, Claude Code, and Cursor:

```json
{
  "mcpServers": {
    "openjev": {
      "command": "openjev-mcp",
      "env": { "OPENJEV_API_KEY": "oj_live_…" }
    }
  }
}
```

These clients do **not** read `.env` files. The key belongs in the `env` block, and that
is the only mechanism they share.

---

## 3. Running it yourself

A terminal run has no client to supply anything, so the shell must:

```bash
# one command
OPENJEV_API_KEY=oj_live_… openjev-mcp --check

# or for the session
export OPENJEV_API_KEY=oj_live_…
openjev-mcp --check
```

To read the key from a file, `--env-file` must come **before** the script name:

```bash
node --env-file="$HOME/.dsh/.env" /path/to/openjev-mcp/dist/index.js --check
```

Quote the path with `$HOME` rather than `~`: a shell does not expand a tilde that follows
`--env-file=`, and Node then reports the file as not found.

> Starting `openjev-mcp` by hand proves nothing on its own — with a working key it prints
> one line to stderr and waits for a client that never arrives. Use `--check`.

---

## 4. Verify

```bash
openjev-mcp --check
```

| Exit | Meaning | Next step |
| --- | --- | --- |
| `0` | Key, endpoint, and round trip all work | None |
| `1` | The API rejected the key, or the network failed | Fix the key, then restart the client |
| `2` | No key in this process's environment | This page |

`--check` spends one small judgment (~316 in / 32 out tokens).

---

## 5. What does not work

Each of these has been observed in practice. The symptom column is what makes them
identifiable.

| Attempt | Symptom | Why it fails |
| --- | --- | --- |
| `env:` block in `~/.dsh/settings.yaml` (the GUI settings panel) | No effect at all | `settings.yaml` holds *plugin namespaces* (`ui-theme`, `agent-presets`). No plugin owns `env`, so the section is ignored — and `!!js` is not part of that document's dialect, so the value would be the literal string anyway |
| `args: ["--env-file=/path/.env"]` beside `command: openjev-mcp` | Server starts, then every call fails with no key | Node validates `--env-file` in that position but does not load it. Use the `env` block, or `command: node` with the flag before the script |
| A `.env` in the project directory | Ignored | Nothing scans for it. Only an explicit `--env-file` reads one |
| `export OPENJEV_API_KEY=…` in a shell profile *and* a value in `~/.dsh/.env` | Editing the file appears to do nothing | The inherited environment wins over every file |
| Editing `~/.dsh/.env` without restarting the harness | Still the old key | The environment is read at startup |
| Typing `openjev-mcp` in a terminal and expecting it to read your client's config | `OPENJEV_API_KEY is not set` | A bare shell reads none of these files; that command is meant to be run by a client |

---

## 6. Rotation

1. Issue the replacement at <https://openjev.sh/dashboard>.
2. Update the location from the table above — for the harness, `~/.dsh/.env`.
3. Restart the client (the harness, or whichever client you configured).
4. `openjev-mcp --check` → exit `0`.
5. Revoke the previous key.

Keep exactly one canonical copy per machine where practical: every additional copy is
another artifact to rotate. Operational detail, including the alerting and audit
considerations, is in [`production.md`](production.md#3-credential-management).
