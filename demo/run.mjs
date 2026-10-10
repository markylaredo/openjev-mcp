// README demo: an MCP client spawns the built server over stdio and makes one
// real `jev_ask` call. Run it through demo/demo.tape to regenerate demo.gif.
//
//   npm run build && OPENJEV_API_KEY=... node demo/run.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const bar = (p) => '█'.repeat(Math.round(p * 20)).padEnd(20, '░');

const ticket = "Charged twice for my subscription again. I need the refund before rent is due Friday!";

const args = {
  state: ticket,
  questions: {
    team: {
      type: 'choice',
      instructions: 'Which team should handle this ticket?',
      criteria: {
        billing: 'Payments, charges, refunds',
        technical: 'Bugs, outages, integrations',
        sales: 'Pricing questions and new accounts',
        other: 'Anything else',
      },
    },
    sentiment: {
      type: 'score',
      instructions: 'How frustrated is the customer?',
      criteria: ['Calm', 'Annoyed', 'Angry'],
    },
    urgent: {
      type: 'noul',
      instructions: 'Is there a concrete deadline the customer needs met?',
    },
  },
};

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [new URL('../dist/index.js', import.meta.url).pathname],
  env: { ...process.env },
  stderr: 'ignore',
});
const client = new Client({ name: 'demo', version: '1.0.0' });
await client.connect(transport);

console.log(dim('ticket: ') + `"${ticket}"`);
console.log(dim('calling ') + cyan('jev_ask') + dim(' with 3 questions in one request…\n'));

const result = await client.callTool({ name: 'jev_ask', arguments: args });
await client.close();
if (result.isError) {
  console.error(result.content.map((c) => c.text).join('\n'));
  process.exit(1);
}
const { answers, usage } = result.structuredContent;

const { team, sentiment, urgent } = answers;
console.log(bold('team      ') + green(team.choice.padEnd(10)) + dim(`confidence ${team.confidence.toFixed(2)}`));
for (const [option, p] of Object.entries(team.probabilities).sort((a, b) => b[1] - a[1])) {
  console.log(dim(`  ${option.padEnd(10)}${bar(p)} ${p.toFixed(2)}`));
}
const level = sentiment.legend[String(Math.round(sentiment.score))];
console.log(bold('sentiment ') + green(`${sentiment.score.toFixed(2)} / 2`) + dim(`  → ${level}`));
console.log(bold('urgent    ') + green(urgent.noul.toFixed(2)) + dim(`      ${bar(urgent.noul)}`));
console.log(dim(`\ntyped JSON, ready to branch on · ${usage.input_tokens} in / ${usage.output_tokens} out tokens`));
