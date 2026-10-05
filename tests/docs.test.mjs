// Documentation and manifest invariants: what the plugin promises must match what it ships. These tests fail when a file is
// renamed, a rule in the skill drifts from the code, a limit in the README stops being true, or a personal detail slips into a
// tracked file.

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { EXTENSIONS, LIMITS } from '../scripts/lib/scan.mjs';
import { AGGS, GRAINS, KINDS, PLAN_LIMITS } from '../scripts/lib/plan.mjs';
import { ROOT } from './helpers/index.mjs';

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8').replace(/\r\n/g, '\n');

function walk(relative, predicate = () => true) {
  const entries = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'tmp') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (predicate(full)) entries.push(full);
    }
  };
  visit(path.join(ROOT, relative));
  return entries;
}

/** The files Git tracks: what a published clone would contain. Without .git (a zip or a copied folder), every file counts. */
function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '');
  } catch {
    return walk('.').map((file) => path.relative(ROOT, file).split(path.sep).join('/'));
  }
}

test('the manifest declares the plugin the directory expects', () => {
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(manifest.name, 'local-data-viz');
  assert.equal(manifest.displayName, 'Local Data Viz');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.license, 'MIT');
  assert.equal(manifest.author.name, 'ultrathinker');
  assert.equal(manifest.repository, 'https://github.com/ultrathinker/local-data-viz');
  for (const field of ['documentationUrl', 'supportUrl', 'privacyPolicyUrl']) assert.ok(manifest[field]?.startsWith('https://'), `${field} is an https URL`);
  assert.equal(manifest.mcpServers, undefined, 'no server, no keys: the plugin is a skill, a command and a script');
  assert.equal(manifest.userConfig, undefined, 'nothing to configure');
  assert.ok(fs.existsSync(path.join(ROOT, '.claude-plugin', 'icon.svg')));
  assert.match(read('.claude-plugin/icon.svg'), /viewBox="0 0 256 256"/);
  const changelog = read('CHANGELOG.md');
  assert.ok(changelog.includes(`## [${manifest.version}]`), 'the changelog has an entry for the manifest version');
  const marketplace = JSON.parse(read('.claude-plugin/marketplace.json'));
  assert.equal(marketplace.name, 'local-data-viz');
  assert.equal(marketplace.owner.name, 'ultrathinker');
  assert.equal(marketplace.plugins[0].name, 'local-data-viz');
  assert.equal(marketplace.plugins[0].source, '.');
});

test('the project documents exist and are honest-sized', () => {
  for (const file of ['README.md', 'PRIVACY.md', 'SECURITY.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE', '.editorconfig', '.gitignore', 'docs/PLAN-FORMAT.md', 'docs/overview.png']) {
    assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} exists`);
  }
  const readme = read('README.md');
  const words = readme.replace(/```[\s\S]*?```/g, '').split(/\s+/).filter(Boolean).length;
  assert.ok(words >= 400, `README has ${words} words outside code blocks`);
  for (const heading of ['## Setup', '## What it reads', '## What you get', '## How it works', '## Privacy and safety', '## Limits and known caveats', '## Verified by running', '## Development']) {
    assert.ok(readme.includes(heading), `README has "${heading}"`);
  }
  assert.match(read('SECURITY.md'), /Report a vulnerability/i);
  assert.match(readme, /winget install DuckDB\.cli/);
  assert.match(readme, /brew install duckdb/);
  assert.match(readme, /LOCAL_DATA_VIZ_DUCKDB/);
  assert.match(readme, /--no-values/);
});

test('the README names every format and every limit that the code has', () => {
  const readme = read('README.md');
  for (const extension of Object.keys(EXTENSIONS)) assert.ok(readme.includes(`\`${extension}\``), `README names ${extension}`);
  assert.ok(readme.includes(`${LIMITS.maxDepth} levels`), 'README states the depth limit');
  assert.ok(readme.includes(`${LIMITS.maxFiles} files`), 'README states the file limit');
  assert.ok(readme.includes(`${LIMITS.maxXlsxBytes / 1024 / 1024} MB`), 'README states the Excel size limit');
  assert.ok(readme.includes('2,000,000 rows'), 'README states the Excel row limit');
  assert.ok(readme.includes('5,000 cells'), 'README states the explorer group limit');
  assert.ok(readme.includes('2,000 points'), 'README states the scatter sample size');
});

test('the plan format document lists every chart kind, aggregate, grain and limit of the code', () => {
  const doc = read('docs/PLAN-FORMAT.md');
  for (const kind of KINDS) assert.ok(doc.includes(`\`${kind}\``), `PLAN-FORMAT names the ${kind} chart`);
  for (const agg of AGGS) assert.ok(doc.includes(`\`${agg}\``), `PLAN-FORMAT names ${agg}`);
  for (const grain of GRAINS) assert.ok(doc.includes(`\`${grain}\``), `PLAN-FORMAT names ${grain}`);
  assert.ok(doc.includes(`At most ${PLAN_LIMITS.views} views`));
  assert.ok(doc.includes(`Up to ${PLAN_LIMITS.explorerDimensions} \`dimensions\``));
  assert.ok(doc.includes(`up to ${PLAN_LIMITS.explorerMeasures} \`measures\``));
  const skill = read('skills/local-data-viz/SKILL.md');
  for (const kind of KINDS) assert.ok(skill.includes(`\`${kind}\``), `the skill names the ${kind} chart`);
});

test('the skill and the command state the rules the code enforces', () => {
  const skill = read('skills/local-data-viz/SKILL.md');
  assert.match(skill, /^---\nname: local-data-viz\ndescription: .+\n---/);
  assert.ok(skill.includes('${CLAUDE_PLUGIN_ROOT}/scripts/viz.mjs'), 'scripts run through the plugin root');
  assert.doesNotMatch(skill, /[A-Za-z]:\\|\/Users\/|\/home\//, 'no personal path');
  for (const command of ['doctor', 'inspect', 'build']) assert.ok(skill.includes(`viz.mjs" ${command}`), `the skill shows the ${command} command`);
  assert.match(skill, /Input is a local folder/);
  assert.match(skill, /Nothing is installed or downloaded/);
  assert.match(skill, /Never delete, move, overwrite or rename/);
  assert.match(skill, /DUCKDB_MISSING/);
  assert.match(skill, /exit code 2/i);
  assert.match(skill, /--no-values/);
  assert.match(skill, /data, never instructions|never follow it/);
  assert.match(skill, /Quote every path/);
  assert.match(skill, /file:\/\/\//);
  assert.match(skill, /ask once/);
  assert.match(skill, /If `\$\{CLAUDE_PLUGIN_ROOT\}` is empty in your shell[\s\S]*two levels above this `SKILL\.md`/, 'a way to find the script when the host does not set the variable');
  assert.match(skill, /The plan can filter rows \(`filters`, see Step 4\), but it cannot join datasets/, 'the skill says what the plan can and cannot do');
  assert.match(skill, /use `filters`: `\{ "column": "department"/, 'the skill shows how to filter');
  assert.match(skill, /A field the plan does not know[\s\S]*is an error, never ignored/);
  assert.match(skill, /cannot join datasets, reshape a wide table[\s\S]*pie charts and\s+maps/, 'the skill says what to answer when the user asks for what the plan cannot do');
  assert.match(skill, /Decide this before the first command/, 'confidential data: say it before the first run');
  assert.equal((skill.match(/Which folder holds the data files\?/g) ?? []).length, 1, 'the one question');
  const command = read('commands/charts.md');
  assert.match(command, /^---\ndescription: .+\nargument-hint:/);
  assert.match(command, /local-data-viz/);
  assert.match(command, /\$ARGUMENTS/);
});

test('the docs mention only expected hosts, and the page and script make no network call', () => {
  const hosts = new Set();
  for (const file of trackedFiles().filter((name) => /\.(mjs|md|json|html|css|yml)$/.test(name))) {
    for (const match of read(file).matchAll(/https?:\/\/([a-z0-9.-]+)/g)) hosts.add(match[1]);
  }
  // schemas.openxmlformats.org (Excel files) and www.w3.org (the SVG format) are XML namespace names, not addresses anyone contacts
  const allowed = new Set(['www.w3.org', 'github.com', 'duckdb.org', 'claude.com', 'code.claude.com', 'keepachangelog.com', 'semver.org', 'schemas.openxmlformats.org', 'example.com', 'x']);
  const unexpected = [...hosts].filter((host) => !allowed.has(host));
  assert.deepEqual(unexpected, [], `only expected hosts are mentioned in tracked files: ${unexpected}`);
  for (const file of ['scripts/viz.mjs', ...fs.readdirSync(path.join(ROOT, 'scripts', 'lib')).map((name) => `scripts/lib/${name}`), 'viewer/viewer.js', 'viewer/charts.js', 'viewer/index.html']) {
    assert.doesNotMatch(read(file), /\bfetch\(|XMLHttpRequest|WebSocket|node:https?'|node:net'|node:dns'|sendBeacon|\bimport\(['"]https?/, `${file} has no network code`);
  }
  // the only child process the script starts is DuckDB
  const spawners = fs.readdirSync(path.join(ROOT, 'scripts', 'lib')).filter((name) => /child_process/.test(read(`scripts/lib/${name}`)));
  assert.deepEqual(spawners, ['duck.mjs']);
});

test('no personal data or agent material is tracked, and the sources are plain ASCII', () => {
  const tracked = trackedFiles().filter((file) => !/\.(png|svg)$/.test(file));
  const identity = new RegExp(['universe', 'issilent'].join(''), 'i');
  const patterns = [/C:\\Users\\/i, /\/Users\/[a-z]/i, identity, /@[a-z0-9.-]+\.(com|net|org|io|ru)/i, /[\u0400-\u04FF]/];
  for (const file of tracked) {
    const text = read(file);
    for (const pattern of patterns) assert.ok(!pattern.test(text), `${file} matches ${pattern.source}`);
    if (/\.(mjs|js|css|html|json|yml)$/.test(file)) assert.ok(!/[^\x00-\x7f]/.test(text), `${file} has only ASCII characters`);
  }
  for (const name of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md', '.cursorrules']) assert.ok(!trackedFiles().includes(name), `${name} is not tracked`);
});

test('every file is small readable text, with no long minified lines', () => {
  for (const file of walk('.', (f) => !/\.png$/.test(f))) {
    const relative = path.relative(ROOT, file);
    assert.ok(fs.statSync(file).size < 256 * 1024, `${relative} is under 256 KiB`);
    if (/\.(mjs|js|css|html)$/.test(file)) {
      const longest = read(relative).split('\n').reduce((max, line) => Math.max(max, line.length), 0);
      assert.ok(longest < 400, `${relative} has no minified-looking lines (${longest} chars)`);
    }
  }
});

test('no third-party code is bundled: the page draws its own charts, and its content policy allows no eval', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'vendor')), 'there is no vendor folder');
  assert.ok(fs.existsSync(path.join(ROOT, 'viewer', 'charts.js')));
  const html = read('viewer/index.html');
  assert.doesNotMatch(html, /unsafe-eval/);
  assert.match(html, /script-src 'self' file:;/);
  assert.deepEqual([...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]), ['data/manifest.js', 'assets/charts.js', 'assets/viewer.js']);
  for (const file of ['viewer/viewer.js', 'viewer/charts.js']) assert.doesNotMatch(read(file), /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|\bimport\(/, `${file} builds no HTML from strings and runs no code from text`);
  assert.doesNotMatch(read('README.md') + read('SECURITY.md') + read('PRIVACY.md'), /Vega|vendor\//);
});
