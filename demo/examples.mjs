// The examples GIF: replays the recorded runs in examples/ (the task, the agent's tool
// call, Jev's answers, and the agent's answer) from their transcripts, at a pace you can
// follow. Nothing is sent to OpenJEV, so it needs no key. Run it through
// demo/examples.tape to regenerate examples.gif.
//
//   node demo/examples.mjs [example...]
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

// Each example, with the lines of the agent's answer that the replay quotes, by how they start.
const examples = {
  'coop-complaint': ['Triage complete', '## Routing decision', '- Hazard probability', '**Disposition'],
  'coop-queue': ['All eight tickets', '## Dispatch list', '**⚠ On-call', '1. **T-2303**', '2. **T-2308**',
    '## Two flags', '- **T-2307', '- **T-2306'],
};

const sgr = (n) => (s) => `\x1b[${n}m${s}\x1b[0m`;
const [bold, dim, italic, red, green, yellow, blue, magenta, cyan] = [1, 2, 3, 31, 32, 33, 34, 35, 36].map(sgr);
const visible = (s) => s.replace(/\x1b\[[\d;]*m/g, '').length;
const pad = (s, n) => s + ' '.repeat(Math.max(0, n - visible(s)));
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const bar = (p, n) => '█'.repeat(Math.round(p * n)).padEnd(n, '░');

const tty = process.stdout.isTTY;
const width = Math.min(process.stdout.columns || 110, 110) - 8; // right of the label gutter
const sleep = (ms) => tty && delay(ms);
const write = (s) => process.stdout.write(s);
const gutter = (label = '', color = dim) => `${color(label.padStart(6))}  `;

async function say(label, color, lines, ms) {
  for (const [i, line] of lines.entries()) {
    write(`${gutter(i ? '' : label, color)}${line}\n`);
    await sleep(ms);
  }
}

async function spin(label, color, text, ms) {
  if (!tty) return;
  const frames = '⣾⣽⣻⢿⡿⣟⣯⣷';
  for (let i = 0; i * 80 < ms; i++) {
    write(`\r${gutter(label, color)}${cyan(frames[i % frames.length])} ${dim(text)}`);
    await delay(80);
  }
  write('\r\x1b[2K');
}

// Inline markdown (**bold**, *italic*, `code`) as styled words, so a line can wrap
// without breaking a span.
function words(md, base = (s) => s) {
  const open = new Set();
  return md.split(/\s+/).filter(Boolean).map((word) => {
    let text = '';
    let length = 0;
    for (const part of word.split(/(\*\*|\*|`)/).filter(Boolean)) {
      if (['**', '*', '`'].includes(part) && (part === '`' || !open.has('`'))) {
        if (!open.delete(part)) open.add(part);
        continue;
      }
      // ⚠ draws wider than its cell, so it gets a space of its own.
      let s = open.has('`') ? cyan(part) : part === '⚠' ? `${red(part)} ` : part;
      if (open.has('**')) s = bold(s);
      if (open.has('*')) s = italic(s);
      text += base(s);
      length += part === '⚠' ? 2 : part.length;
    }
    return { text, length };
  });
}

function wrap(ws, n) {
  const lines = [];
  let line = [];
  let length = 0;
  for (const w of ws) {
    if (line.length && length + 1 + w.length > n) {
      lines.push(line.join(' '));
      line = [];
      length = 0;
    }
    length += (line.length ? 1 : 0) + w.length;
    line.push(w.text);
  }
  return line.length ? [...lines, line.join(' ')] : lines;
}

// A line of the agent's markdown answer. One too long for a row keeps its first sentence.
function answerLines(md) {
  const heading = md.match(/^#+ (.*)/);
  if (heading) return [bold(heading[1])];
  const [, marker = '', text] = md.match(/^([-*] |\d+\. )?(.*)/);
  const bullet = /^[-*]/.test(marker) ? '• ' : marker;
  const room = width - bullet.length;
  const first = text.replace(/\*\*|\*|`/g, '').length > room && text.match(/^.*?[.!?](?:\*\*|\*|`)*(?=\s)/);
  return wrap(words(first ? `${first[0]} …` : text), room)
    .map((line, i) => (i ? ' '.repeat(bullet.length) : dim(bullet)) + line);
}

// One typed answer; a noul probability gets a bar `size` cells long.
function cell(answer, size) {
  if (!answer) return red('✗');
  if (answer.type === 'noul') {
    const color = answer.noul >= 0.5 ? (s) => bold(red(s)) : dim;
    return `${color(bar(answer.noul, size))} ${color(answer.noul.toFixed(2))}`;
  }
  if (answer.type === 'choice') {
    const p = answer.probabilities[answer.choice];
    return `${green(answer.choice)} ${(p < 0.8 ? yellow : dim)(p.toFixed(2))}`;
  }
  const top = Object.keys(answer.legend).length - 1;
  const level = answer.legend[Math.round(answer.score)].split(':')[0];
  return `${green(`${+answer.score.toFixed(2)} / ${top}`)} ${dim(level)}`;
}

function load(name) {
  const md = readFileSync(new URL(`../examples/${name}/transcript.md`, import.meta.url), 'utf8')
    .replaceAll('\uFE0F', ''); // emoji presentation selector: keep ⚠ one column wide
  const section = (title) => md.split(/^## /m).find((s) => s.startsWith(`${title}\n`));
  const quote = (s) => s.split('\n').filter((l) => l.startsWith('>')).map((l) => l.replace(/^> ?/, '')).join('\n');
  const json = (s) => [...s.matchAll(/^```json\n([\s\S]*?)^```/gm)].map((m) => JSON.parse(m[1]));
  const meta = new Map([...md.matchAll(/^\| \*\*(.+?)\*\* \| (.+) \|$/gm)].map((m) => [m[1], m[2]]));
  const call = section('The call');
  const answer = quote(section("The agent's answer")).split('\n');
  return {
    name,
    title: md.match(/^# (.+)$/m)[1],
    meta,
    task: quote(section('The task')).split(/\n{2,}/),
    preface: quote(call.match(/^(?:>.*\n)+/m)?.[0] ?? ''),
    rejected: call.includes('Input validation error'),
    tool: call.match(/`mcp__openjev__(\w+)`/)[1],
    args: json(call).at(-1),
    result: json(section('The result'))[0],
    quoted: examples[name].map((start) => {
      const line = answer.find((l) => l.startsWith(start));
      if (!line) throw new Error(`${name}: no line of the agent's answer starts with "${start}"`);
      return line;
    }),
  };
}

async function replay(ex, part) {
  const { questions, items = [] } = ex.args;
  const names = Object.keys(questions);
  const batch = ex.tool === 'jev_batch';
  const [requests, tokens, seconds] = ex.meta.get('OpenJEV').split(' · ');

  write(`${bold(ex.title)}${part ? dim(`  ·  ${part}`) : ''}\n`);
  const agent = ex.meta.get('Agent').split(',')[0];
  const recorded = ex.meta.get('Recorded').split(',')[0];
  write(`${dim(`examples/${ex.name} · ${agent} · recorded ${recorded} · replayed from the transcript`)}\n\n`);
  await sleep(800);

  // Messages the batch lists as items show up once, as rows with their answers.
  const shown = ex.task.filter((p) => !items.some((item) => p.includes(String(item.state))));
  const task = shown.flatMap((p) => wrap(words(p, p.startsWith('"') ? italic : dim), width));
  if (shown.length < ex.task.length) {
    task.push(dim(`+ ${ex.task.length - shown.length} messages, listed below with their answers`));
  }
  await say('task', blue, task, 25);
  await sleep(2500);
  write('\n');

  await spin('agent', magenta, 'thinking', 1200);
  if (ex.preface) {
    await say('agent', magenta, wrap(words(ex.preface), width), 30);
    write('\n');
    await sleep(800);
  }

  const what = batch ? `${items.length} items × ${names.length} questions` : `${names.length} questions about one state`;
  await say('tool', cyan, [`${bold(cyan(ex.tool))} ${dim(`· ${what}`)}`], 400);
  if (ex.rejected) {
    await say('', dim, [`${red('✗')} ${dim("malformed arguments from the model, rejected by the server's input check · retried")}`], 900);
  }

  // The rows the answers fill in: one per question for jev_ask, one per item for jev_batch.
  const { answers } = ex.result;
  const cells = batch
    ? items.map((item) => names.map((q) => cell(answers[item.id]?.[q], 10)))
    : names.map((q) => [cell(answers[q], 20)]);
  const widths = cells[0].map((_, i) => Math.max(batch ? names[i].length : 0, ...cells.map((r) => visible(r[i]))));
  const room = width - widths.reduce((a, b) => a + b + 2, 0);
  const id = Math.max(0, ...items.map((item) => item.id.length)) + 2;
  const lefts = batch
    ? items.map((item) => pad(bold(item.id), id) + dim(cut(String(item.state), room - id)))
    : names.map((q) => pad(bold(q), 10) + pad(dim(questions[q].type), 8) + dim(cut(questions[q].instructions, room - 18)));
  const rows = lefts.map((left, r) => [left, cells[r]]);
  const row = ([left, answered], filled) =>
    `${gutter()}${pad(left, room)}${filled ? answered.map((c, i) => `  ${pad(c, widths[i])}`).join('') : ''}`;

  if (batch) write(`${gutter()}${' '.repeat(room)}${names.map((q, i) => `  ${dim(pad(q, widths[i]))}`).join('')}\n`);
  const done = batch ? `${ex.result.counts.answered}/${ex.result.counts.total} answered` : `${names.length} answers`;
  const status = wrap(words(`${done} · ${seconds} · ${requests} · ${tokens}`, dim), width - 2)
    .map((l, i) => `${gutter()}${i ? '  ' : `${green('✓')} `}${l}\n`).join('');
  if (tty) {
    for (const r of rows) {
      write(`${row(r, false)}\n`);
      await sleep(60);
    }
    await sleep(500);
    await spin('', dim, requests, parseFloat(seconds) * 1000);
    write(status);
    // Fill the answers in from the top row down, then return below the status.
    const below = status.split('\n').length - 1;
    write(`\x1b[${rows.length + below}A`);
    for (const r of rows) {
      write(`\r${row(r, true)}\x1b[K\n`);
      await sleep(120);
    }
    write(`\x1b[${below}B`);
  } else {
    write(`${rows.map((r) => row(r, true)).join('\n')}\n${status}`);
  }
  write('\n');
  await sleep(2000);

  await spin('agent', magenta, 'thinking', 1000);
  await say('agent', magenta, ex.quoted.flatMap(answerLines), 120);
  write(`\n${gutter()}${dim(`whole run ${ex.meta.get('Whole run')} · answer excerpted · full transcript: examples/${ex.name}/transcript.md`)}\n`);
}

const names = process.argv.length > 2 ? process.argv.slice(2) : Object.keys(examples);
for (const name of names) {
  if (!examples[name]) throw new Error(`unknown example "${name}"; try ${Object.keys(examples).join(', ')}`);
}
if (tty) {
  write('\x1b[?25l');
  process.on('exit', () => write('\x1b[?25h'));
  process.on('SIGINT', () => process.exit(130));
}
for (const [i, name] of names.entries()) {
  if (i) {
    await sleep(6000);
    write(tty ? '\x1b[2J\x1b[3J\x1b[H' : '\n');
  }
  await replay(load(name), names.length > 1 ? `${i + 1} of ${names.length}` : '');
}
