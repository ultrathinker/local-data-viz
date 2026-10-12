// A web address given instead of a folder is explained. Needs DuckDB only because the command starts the same way as for a folder.

import test from 'node:test';
import assert from 'node:assert/strict';
import { duckdb, runViz } from './helpers/index.mjs';

const duck = await duckdb();
const options = { skip: duck === null ? 'DuckDB is not installed' : false };

test('a web address instead of a folder is explained, not turned into a path', options, () => {
  const result = runViz(['inspect', 'ftp://host/data.csv']);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /is a web address\. This plugin reads a folder on this computer: download the data into a folder/);
  assert.doesNotMatch(result.stderr, /does not exist/);
});
