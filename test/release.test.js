/**
 * Release preparation: one command sets the version everywhere it lives, turns the
 * Unreleased changelog entries into that version's notes, and refuses anything that
 * would publish without notes or publish backwards. Each test runs the real scripts
 * in a scratch copy of the files they edit.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const scripts = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts');
const json = value => `${JSON.stringify(value, null, 2)}\n`;

// Hand-formatted, as the real one is: the update must change the versions and nothing else.
const SERVER = `{
  "name": "io.github.example/openjev-mcp",
  "version": "0.1.2",
  "packages": [
    {
      "registryType": "npm",
      "identifier": "openjev-mcp",
      "version": "0.1.2",
      "transport": { "type": "stdio" }
    }
  ]
}
`;

const scratch = [];
after(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** A scratch project at 0.1.2, with `unreleased` waiting in the changelog. */
function project(unreleased = '### Added\n- A new tool.\n') {
  const dir = mkdtempSync(path.join(tmpdir(), 'openjev-release-'));
  scratch.push(dir);
  const name = 'openjev-mcp';
  writeFileSync(path.join(dir, 'package.json'), json({ name, version: '0.1.2', mcpName: 'io.github.example/openjev-mcp' }));
  writeFileSync(
    path.join(dir, 'package-lock.json'),
    json({ name, version: '0.1.2', lockfileVersion: 3, requires: true, packages: { '': { name, version: '0.1.2' } } }),
  );
  writeFileSync(path.join(dir, 'server.json'), SERVER);
  writeFileSync(
    path.join(dir, 'CHANGELOG.md'),
    `# Changelog\n\n## [Unreleased]\n\n${unreleased}\n## [0.1.2]\n\n### Changed\n- Something older.\n`,
  );
  mkdirSync(path.join(dir, 'docs'));
  writeFileSync(path.join(dir, 'docs', 'production.md'), '| | |\n| --- | --- |\n| **Applies to** | `openjev-mcp` 0.1.1 |\n');
  return dir;
}

function run(dir, script, ...args) {
  return spawnSync(process.execPath, [path.join(scripts, script), ...args], { cwd: dir, encoding: 'utf8' });
}

const read = (dir, file) => readFileSync(path.join(dir, file), 'utf8');
const files = dir => ['package.json', 'package-lock.json', 'server.json', 'CHANGELOG.md', 'docs/production.md'].map(file => read(dir, file));

describe('npm run release', () => {
  it('sets the version everywhere and turns the Unreleased entries into its notes', () => {
    const dir = project();

    const result = run(dir, 'release.mjs', '0.2.0');

    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(read(dir, 'package.json')).version, '0.2.0');
    const lock = JSON.parse(read(dir, 'package-lock.json'));
    assert.deepEqual([lock.version, lock.packages[''].version], ['0.2.0', '0.2.0']);
    assert.equal(read(dir, 'server.json'), SERVER.replaceAll('0.1.2', '0.2.0'), 'only the version fields change');
    assert.equal(
      read(dir, 'CHANGELOG.md'),
      '# Changelog\n\n## [Unreleased]\n\n## [0.2.0]\n\n### Added\n- A new tool.\n\n## [0.1.2]\n\n### Changed\n- Something older.\n',
    );
    assert.match(read(dir, 'docs/production.md'), /`openjev-mcp` 0\.2\.0 \|/);
    assert.match(result.stdout, /git commit -m "🔖 chore\(release\): v0\.2\.0" -- package\.json/);
  });

  it('bumps major, minor, or patch from the newest release in the changelog', () => {
    for (const [keyword, expected] of [['patch', '0.1.3'], ['minor', '0.2.0'], ['major', '1.0.0']]) {
      const dir = project();
      assert.equal(run(dir, 'release.mjs', keyword).status, 0, keyword);
      assert.equal(JSON.parse(read(dir, 'package.json')).version, expected, keyword);
    }
  });

  it('refuses, and touches nothing, when a release would lack notes or go backwards', () => {
    const cases = [
      [project(''), ['0.2.0'], /nothing under ## \[Unreleased\]/],
      [project(), ['0.1.1'], /0\.1\.1 is not newer than the last release, 0\.1\.2/],
      [project(), ['0.1.2'], /already has ## \[0\.1\.2\], and ## \[Unreleased\] has entries waiting/],
      [project(), ['v0.2.0'], /"v0\.2\.0" is not a version like 1\.2\.3/],
      [project(), [], /usage: npm run release/],
    ];
    for (const [dir, args, message] of cases) {
      const before = files(dir);
      const result = run(dir, 'release.mjs', ...args);
      assert.equal(result.status, 1, `${args} must be refused`);
      assert.match(result.stderr, message);
      assert.deepEqual(files(dir), before, `a refused ${args} must not touch any file`);
    }
  });

  it('leaves a server.json with an unexpected "version" field to a person', () => {
    const dir = project();
    writeFileSync(path.join(dir, 'server.json'), SERVER.replace('{\n', '{\n  "_meta": { "version": "2" },\n'));
    const before = files(dir);

    const result = run(dir, 'release.mjs', '0.2.0');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /server\.json has 3 "version" fields, but expected 2/);
    assert.deepEqual(files(dir), before);
  });

  it('is safe to run again, and will not bump twice', () => {
    const dir = project();
    run(dir, 'release.mjs', '0.2.0');
    const prepared = files(dir);

    assert.equal(run(dir, 'release.mjs', '0.2.0').status, 0);
    assert.deepEqual(files(dir), prepared);
    // A second `minor` would need new notes, so it stops rather than make 0.3.0.
    assert.match(run(dir, 'release.mjs', 'minor').stderr, /nothing under ## \[Unreleased\]/);
  });

  it('finishes a bump that was started by hand', () => {
    const dir = project();
    writeFileSync(path.join(dir, 'package.json'), read(dir, 'package.json').replace('0.1.2', '0.2.0'));

    assert.equal(run(dir, 'release.mjs', '0.2.0').status, 0);
    assert.equal(JSON.parse(read(dir, 'package-lock.json')).version, '0.2.0');
  });

  it('prints a version\'s notes for its GitHub release', () => {
    const dir = project();
    run(dir, 'release.mjs', '0.2.0');

    const notes = run(dir, 'release.mjs', 'notes', '0.2.0');
    assert.equal(notes.status, 0);
    assert.equal(notes.stdout, '### Added\n- A new tool.\n');
    assert.equal(run(dir, 'release.mjs', 'notes', '9.9.9').status, 1);
  });
});

describe('check-versions', () => {
  it('catches a lockfile that a hand edit left behind', () => {
    const dir = project();
    for (const file of ['package.json', 'server.json']) {
      writeFileSync(path.join(dir, file), read(dir, file).replaceAll('0.1.2', '0.2.0'));
    }

    const result = run(dir, 'check-versions.mjs');

    assert.equal(result.status, 1);
    assert.match(result.stderr, /package-lock\.json version is 0\.1\.2, expected 0\.2\.0/);
  });
});
