#!/usr/bin/env node
// local-data-viz: turn a folder of data files into a folder with a page of charts, all on this computer.
//   viz.mjs doctor
//   viz.mjs inspect <folder> [--no-values] [--max-files N] [--out <dir>]
//   viz.mjs plan    <folder> [--no-values] [--out <dir>]
//   viz.mjs build   <folder> [--plan <file>] [--no-values] [--out <dir>]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MIN_DUCKDB, findDuckdb } from './lib/duck.mjs';
import { USAGE, parseArgs } from './lib/args.mjs';
import { buildSite } from './lib/build.mjs';
import { normalizePlan } from './lib/plan.mjs';
import { UserError, draftPlan, formatReport, installMessage, loadProfile, saveDraftPlan, tidy } from './lib/pipeline.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const STARTED = Date.now();

const log = (message) => process.stderr.write(`[${((Date.now() - STARTED) / 1000).toFixed(1)}s] ${message}\n`);

async function doctor() {
  const major = Number(process.versions.node.split('.')[0]);
  const lines = [`Node ${process.versions.node}: ${major >= 18 ? 'ok' : 'too old (18 or newer is needed)'}`];
  const duck = await findDuckdb(process.env);
  if (!duck.found) lines.push(installMessage('DuckDB was not found.'));
  else if (!duck.supported) lines.push(installMessage(`DuckDB ${duck.versionText} is too old (${MIN_DUCKDB.join('.')} or newer is needed).`));
  else lines.push(`DuckDB ${duck.versionText}: ok (${duck.via})`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return major >= 18 && duck.found && duck.supported ? 0 : 2;
}

function readPlanFile(file) {
  let text;
  try {
    text = fs.readFileSync(path.resolve(file), 'utf8');
  } catch {
    throw new UserError(`cannot read the plan file ${file}`);
  }
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw new UserError(`the plan file is not valid JSON: ${error.message}`);
  }
}

async function run(argv) {
  const { positional, options } = parseArgs(argv);
  const [command, folder, ...extra] = positional;
  if (command === undefined || command === 'help') {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (command === 'doctor') return doctor();
  if (!['inspect', 'plan', 'build'].includes(command)) throw new UserError(`unknown command "${command}"\n\n${USAGE}`);
  if (folder === undefined || extra.length > 0) throw new UserError(`${command} needs exactly one folder\n\n${USAGE}`);
  if (command !== 'build' && options.plan !== undefined) throw new UserError('--plan is only for build');

  const context = await loadProfile(folder, { ...options, log });
  const draft = draftPlan(context.datasets, path.basename(context.root));
  const draftFile = saveDraftPlan(context, draft);

  if (command === 'inspect') {
    process.stdout.write(`${formatReport(context, draft, draftFile)}\n\nNext: edit the plan if needed, then run: build "${context.root}" --plan <plan file>\n`);
    return 0;
  }
  if (command === 'plan') {
    process.stdout.write(`${JSON.stringify(draft, null, 2)}\n`);
    log(`the same plan is saved in ${draftFile}`);
    return 0;
  }

  let plan;
  try {
    plan = normalizePlan(options.plan === undefined ? draft : readPlanFile(options.plan), context.datasets);
  } catch (error) {
    throw error instanceof UserError ? error : new UserError(error.message);
  }
  const result = await buildSite({
    bin: context.duck.bin,
    pluginRoot: PLUGIN_ROOT,
    datasets: context.datasets,
    plan,
    scan: context.scan,
    skippedFiles: context.skippedFiles,
    notes: context.notes.map((item) => `${item.file}: ${item.text}`),
    parentDir: context.projectDir,
    log,
  });
  const lines = [`Built ${result.views} chart${result.views === 1 ? '' : 's'} and ${result.explorers} explorer${result.explorers === 1 ? '' : 's'}.`, `Folder: ${result.outDir}`, `Open in a browser: ${pathToFileURL(result.indexFile).href}`];
  for (const item of result.failed) lines.push(`NOT BUILT: ${item.title} - ${item.reason}`);
  for (const text of result.notices) lines.push(`NOTE: ${text}`);
  const notRead = [...context.skippedFiles, ...context.scan.skipped];
  if (notRead.length > 0) lines.push(`NOT READ (${notRead.length} file${notRead.length === 1 ? '' : 's'}, so the page leaves out their data): ${notRead.slice(0, 5).map((item) => `${tidy(item.file, 80)} - ${tidy(item.reason, 120)}`).join('; ')}${notRead.length > 5 ? '; ...' : ''}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

try {
  process.exitCode = await run(process.argv.slice(2));
} catch (error) {
  if (error instanceof UserError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = error.exitCode;
  } else {
    process.stderr.write(`unexpected error: ${error.stack ?? error.message}\n`);
    process.exitCode = 3;
  }
}
