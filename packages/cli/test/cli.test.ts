import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(__dirname, '../src/index.js');

test('cli help prints usage text', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, '--help']);

  assert.match(stdout, /Usage:/);
  assert.match(stdout, /giduru analyze/);
  assert.match(stdout, /giduru check/);
});

test('cli analyze prints analysis JSON for a root ledger file', async () => {
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'giduru-cli-'));
  const rootFilePath = path.join(fixtureDirectory, 'main.journal');

  await writeFile(
    rootFilePath,
    `2024-01-01 Lunch
  Expenses:Food  10 USD
  Assets:Cash  -10 USD
`,
  );

  const { stdout } = await execFileAsync(process.execPath, [cliPath, 'analyze', rootFilePath]);
  const analysis = JSON.parse(stdout) as {
    diagnostics: unknown[];
    register: Array<{ account: string }>;
  };

  assert.deepEqual(analysis.diagnostics, []);
  assert.deepEqual(
    analysis.register.map((entry) => entry.account),
    ['Expenses:Food', 'Assets:Cash'],
  );
});

test('cli check exits non-zero when the ledger has error diagnostics', async () => {
  const fixtureDirectory = await mkdtemp(path.join(tmpdir(), 'giduru-cli-'));
  const rootFilePath = path.join(fixtureDirectory, 'broken.journal');

  await writeFile(
    rootFilePath,
    `2024-01-01 Broken
  Assets:Cash  10 USD
  Equity:OpeningBalances  10 USD
`,
  );

  const result = spawnSync(process.execPath, [cliPath, 'check', rootFilePath], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not balance/);
});
