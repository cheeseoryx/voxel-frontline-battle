#!/usr/bin/env node
// Reuse the engine's real Standard transmission Dawn ROI contract. The app
// remains the browser carrier; this script does not duplicate a second Dawn
// renderer or a demo-specific backend implementation.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..', '..');
const contract = resolve(
  repoRoot,
  'packages/render/src/transmission/__tests__/standard-transmission.dawn.test.ts',
);

if (!existsSync(contract)) {
  console.log(
    '[learn-render 6.4 transmission-refraction] NOT-RUN: the transmission Dawn contract is not present in this checkout; run after the engine transmission pipe is integrated.',
  );
  process.exit(0);
}

const result = spawnSync(
  'pnpm',
  ['exec', 'vitest', 'run', '--project=dawn', '--no-typecheck', contract],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, FORGEAX_DAWN_ISOLATED: '1' },
  },
);
process.exit(result.status ?? 1);
