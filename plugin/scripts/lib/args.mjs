// The command line of viz.mjs: which options exist and how they are read.

import { UserError } from './pipeline.mjs';

export const USAGE = `local-data-viz - charts for a folder of data files, made on this computer

  doctor                         check that Node and DuckDB are ready
  inspect <folder>               read the folder, print what is in it, save a draft plan
  plan <folder>                  print the draft plan as JSON (edit it, then build)
  build <folder>                 make the page; --plan <file> uses an edited plan

options:  --no-values   structure only: print names, types, kinds and counts, never values, ranges, averages or correlations
          --plan <file>   (build) the plan to use; without it the draft plan is built
          --max-files N   read at most N files (default 400)
          --out <dir>   where the work files and the page go (default: <folder>-viz next to the folder)`;

const FLAGS = {
  '--no-values': { key: 'noValues', takes: false },
  '--max-files': { key: 'maxFiles', takes: true },
  '--out': { key: 'out', takes: true },
  '--plan': { key: 'plan', takes: true },
};

export function parseArgs(argv) {
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { positional: ['help'], options: {} };
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.split(/=(.*)/s, 2);
    const flag = FLAGS[name];
    if (flag === undefined) throw new UserError(`unknown option ${name}\n\n${USAGE}`);
    if (!flag.takes) {
      options[flag.key] = true;
      continue;
    }
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw new UserError(`${name} needs a value`);
    options[flag.key] = value;
  }
  if (options.maxFiles !== undefined) {
    const n = Number(options.maxFiles);
    if (!Number.isInteger(n) || n < 1 || n > 5000) throw new UserError('--max-files must be a whole number from 1 to 5000');
    options.maxFiles = n;
  }
  return { positional, options };
}
