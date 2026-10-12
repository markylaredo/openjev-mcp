// Fails when package.json, package-lock.json, server.json, and (optionally) a release
// version disagree. The MCP Registry rejects a server.json that points at an npm
// version that does not exist, so a mismatch must stop a release before it starts.
// `npm run release` keeps them in step; this catches a hand edit that did not.
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const server = JSON.parse(readFileSync('server.json', 'utf8'));
const tag = process.argv[2];

const versions = {
  'package.json version': pkg.version,
  'package-lock.json version': lock.version,
  'package-lock.json packages[""].version': lock.packages?.['']?.version,
  'server.json version': server.version,
  ...Object.fromEntries(server.packages.map((p, i) => [`server.json packages[${i}].version`, p.version])),
  ...(tag ? { 'release tag': tag } : {}),
};

const problems = [];
for (const [where, version] of Object.entries(versions)) {
  if (version !== pkg.version) problems.push(`${where} is ${version}, expected ${pkg.version}`);
}
if (server.name !== pkg.mcpName) problems.push(`server.json name ${server.name} != package.json mcpName ${pkg.mcpName}`);

if (problems.length) {
  console.error(problems.map((p) => `- ${p}`).join('\n'));
  process.exit(1);
}
console.log(`versions agree: ${pkg.version}`);
