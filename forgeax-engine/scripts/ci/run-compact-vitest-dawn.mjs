#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DAWN_COMPACT_TEST_FILES } from './dawn-compact-roster.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const VITEST = resolve(ROOT, 'node_modules/vitest/vitest.mjs');

for (const file of DAWN_COMPACT_TEST_FILES) {
  if (!existsSync(resolve(ROOT, file))) {
    throw new Error(`Dawn shared roster entry does not exist: ${file}`);
  }
}

const child = spawn(
  process.execPath,
  [
    VITEST,
    'run',
    '--project=dawn',
    '--no-isolate',
    '--maxWorkers=1',
    '--no-file-parallelism',
    ...DAWN_COMPACT_TEST_FILES,
  ],
  {
    cwd: ROOT,
    env: { ...process.env, FORGEAX_DAWN_COMPACT: '1' },
    stdio: 'inherit',
  },
);

child.once('error', (error) => {
  console.error(`[dawn-shared] ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
});
child.once('exit', (code, signal) => {
  if (signal !== null) {
    console.error(`[dawn-shared] terminated by ${signal}`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = code ?? 1;
});
