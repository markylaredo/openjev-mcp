# Examples

Real runs, start to finish. An agent gets a help-desk task in plain words, decides how to
use the openjev tools, and acts on the typed answers. Each transcript is copied from the
agent's session log: the task, every tool call and result, and the final answer.

![Both runs replayed: one member complaint gets four typed answers from a jev_ask call and goes to the on-call line crew, then eight queued messages are triaged in one jev_batch call and the two hazards are dispatched first](../demo/examples.gif)

<sub>Both transcripts replayed by [`demo/examples.mjs`](../demo/examples.mjs): the recorded
words and numbers, with the agent's thinking time cut and its answers excerpted. Watch it
in a terminal with `node demo/examples.mjs`; no key needed.</sub>

| Example | Tool | What it shows |
| --- | --- | --- |
| [One complaint, four judgments](coop-complaint/transcript.md) | `jev_ask` | Category, urgency, safety hazard, and how upset the member is, from one call, routed by the co-op's own thresholds |
| [This morning's queue](coop-queue/transcript.md) | `jev_batch` | Eight member messages triaged in one tool call and keyed by ticket id, with hazards dispatched first |

Both come from an electric cooperative's help desk, where a misfiled message can leave a
live line down on a school route.

## How they were recorded

- **Agent:** [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), the
  reference client, in its one-shot `headless` profile, running `deepseek-flash`.
- **Server:** this repository's build (0.1.2 plus `jev_batch`) with default settings,
  attached by a copy of [`openjev.patch.yml`](openjev.patch.yml) pointed at
  `dist/index.js`.
- **Workspace:** an empty directory, so the agent had nothing to work with but the tools.
- **Edits:** JSON is re-indented, the model's private reasoning is left out, and the
  malformed attempts the server rejected are described rather than reprinted. Nothing
  else is changed or removed.

The answers are live model output from 2026-10-12, so a new recording will differ in the
details.

## Record one yourself

With `OPENJEV_API_KEY` in the harness environment (`~/.dsh/.env`), from the repository
root:

```bash
dsh --profile headless --patch examples/openjev.patch.yml "$(cat examples/coop-queue/task.md)"
```

The final answer prints to stdout. The full session, tool calls and results included, is
kept in the harness's session history under `~/.dsh/sessions/`.

Each `task.md` is a plain prompt, so it also works in Claude Code, Claude Desktop, Cursor,
or any other client with openjev-mcp configured.
