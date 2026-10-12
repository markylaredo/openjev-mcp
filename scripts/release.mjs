// Prepares a release in the working tree: sets the version everywhere it lives and
// turns the Unreleased changelog entries into that version's notes. Merging the
// result to main publishes it (.github/workflows/release.yml).
//
//   npm run release -- 0.2.0                 an exact version
//   npm run release -- minor                 major, minor, or patch from the last release
//   node scripts/release.mjs notes 0.2.0     print that version's changelog section
//
// The last release is the newest version heading in CHANGELOG.md. Every check runs
// before any file is written, and running again for the same version is safe.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const HEADING = /^## \[([^\]]+)\]/;
const MANIFESTS = ['package.json', 'package-lock.json', 'server.json', 'CHANGELOG.md', 'docs/production.md'];

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function compare(a, b) {
  const [x, y] = [a, b].map(version => version.split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/** CHANGELOG.md as lines, with each `## [name]` section's line range. */
function readChangelog() {
  const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
  const sections = [];
  lines.forEach((line, index) => {
    const match = HEADING.exec(line);
    if (match) sections.push({ name: match[1], start: index, end: lines.length });
  });
  sections.forEach((section, i) => {
    if (i + 1 < sections.length) section.end = sections[i + 1].start;
  });
  const body = section => lines.slice(section.start + 1, section.end).join('\n').trim();
  return { lines, sections, body };
}

const json = value => `${JSON.stringify(value, null, 2)}\n`;
const [command, argument] = process.argv.slice(2);
const changelog = readChangelog();

if (command === 'notes') {
  const section = changelog.sections.find(s => s.name === argument);
  const notes = section ? changelog.body(section) : '';
  if (notes === '') fail(`CHANGELOG.md has no notes under ## [${argument}].`);
  process.stdout.write(`${notes}\n`);
  process.exit(0);
}

if (command === undefined) fail('usage: npm run release -- <version | major | minor | patch>');
const released = changelog.sections.map(s => s.name).filter(name => SEMVER.test(name));
let version = command;
if (['major', 'minor', 'patch'].includes(command)) {
  if (released.length === 0) fail('CHANGELOG.md has no released version to bump from; give an exact version.');
  const [major, minor, patch] = released[0].split('.').map(Number);
  version = { major: `${major + 1}.0.0`, minor: `${major}.${minor + 1}.0`, patch: `${major}.${minor}.${patch + 1}` }[command];
} else if (!SEMVER.test(command)) {
  fail(`"${command}" is not a version like 1.2.3, or major, minor, or patch.`);
}
const previous = released.find(name => name !== version);
if (previous !== undefined && compare(version, previous) <= 0) {
  fail(`${version} is not newer than the last release, ${previous}.`);
}
const unreleased = changelog.sections.find(s => s.name === 'Unreleased');
const pending = unreleased !== undefined && changelog.body(unreleased) !== '';
const prepared = changelog.sections.some(s => s.name === version);
// A heading for this version with new entries still above it means it went out
// before those entries were written: they need a newer version.
if (prepared && pending) {
  fail(`CHANGELOG.md already has ## [${version}], and ## [Unreleased] has entries waiting for a newer version.`);
}

// Compute every change first, so a refusal leaves the working tree untouched.
const writes = [];

// The Unreleased entries become this version's notes: the heading goes in under
// [Unreleased], which stays in place, empty, for the next round.
if (!prepared) {
  if (!pending) fail('CHANGELOG.md has nothing under ## [Unreleased]; those entries become the release notes.');
  const lines = [...changelog.lines];
  lines.splice(unreleased.start + 1, 0, '', `## [${version}]`);
  writes.push(['CHANGELOG.md', lines.join('\n')]);
}

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
writes.push(['package.json', json({ ...pkg, version })]);

const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
lock.version = version;
if (lock.packages?.[''] !== undefined) lock.packages[''].version = version;
writes.push(['package-lock.json', json(lock)]);

// Replaced in place rather than re-serialized, so the file keeps its hand formatting.
// Counting the fields guards against a new "version" key the registry did not mean.
const serverText = readFileSync('server.json', 'utf8');
const expected = 1 + (JSON.parse(serverText).packages?.length ?? 0);
let found = 0;
const server = serverText.replace(/("version"\s*:\s*)"[^"]*"/g, (_, key) => {
  found += 1;
  return `${key}"${version}"`;
});
if (found !== expected) {
  fail(`server.json has ${found} "version" fields, but expected ${expected} (the server and each package); update it by hand.`);
}
writes.push(['server.json', server]);

if (existsSync('docs/production.md')) {
  const guide = readFileSync('docs/production.md', 'utf8');
  writes.push(['docs/production.md', guide.replace(/(\| \*\*Applies to\*\* \| `openjev-mcp` )\d+\.\d+\.\d+/, `$1${version}`)]);
}

for (const [file, text] of writes) writeFileSync(file, text);
try {
  execFileSync(process.execPath, [fileURLToPath(new URL('./check-versions.mjs', import.meta.url)), version], {
    stdio: 'inherit',
  });
} catch {
  fail('the manifests still disagree after the update; fix what is listed above.');
}

console.log(`
Prepared v${version}. Commit it, then open a pull request and merge it; merging to main
publishes v${version} to npm and the MCP Registry and creates its GitHub release.

  git commit -m "🔖 chore(release): v${version}" -- ${MANIFESTS.join(' ')}
`);
