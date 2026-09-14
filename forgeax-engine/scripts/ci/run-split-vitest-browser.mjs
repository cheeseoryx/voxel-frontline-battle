#!/usr/bin/env node

import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isRetryableOutput, runBrowserCommand } from './run-browser-gate-with-retry.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(scriptDir, '../..');
// Regular groups pay one fresh Vite/Chrome startup. Keep the startup boundary
// for the genuinely cold GPU/asset owners, but let contract-only browser
// files share the normal bounded group so CI spends its budget on assertions
// instead of repeatedly booting identical browsers.
const defaultGroupSize = 8;
const defaultMaxWorkers = 1;
const browserGroupTimeoutMs = 300_000;
const directLightBrowserGroupTimeoutMs = 420_000;
const browserNodeHeapArg = '--max-old-space-size=4096';
const defaultShardCount = 1;
const defaultShardIndex = 0;
const defaultShardStrategy = 'round-robin';
const entityVisibilityBrowserTest =
  'apps/hello/entity-visibility/src/__tests__/visibility.browser.test.ts';
const r32floatCapabilityGenerationTest =
  'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
const advancedLightingBrowserFiles = new Set([
  'apps/learn-render/5.advanced-lighting/6.hdr/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/7.bloom/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/8.deferred-shading/src/__tests__/onerror-gate.browser.test.ts',
  'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts',
]);
const iblIrradianceBrowserFile =
  'apps/learn-render/6.pbr/2.ibl-irradiance/src/__tests__/onerror-gate.browser.test.ts';
const iblSpecularBrowserFile =
  'apps/learn-render/6.pbr/3.ibl-specular/src/__tests__/onerror-gate.browser.test.ts';
const transmissionBrowserFile =
  'apps/learn-render/6.pbr/4.transmission-refraction/src/__tests__/onerror-gate.browser.test.ts';
const directLightBrowserFile =
  'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts';
const instancingStaticBrowserFile =
  'apps/parity/instancing-static/src/__tests__/instances.browser.test.ts';
const browserProcessIsolatedFiles = new Set([
  ...advancedLightingBrowserFiles,
  iblIrradianceBrowserFile,
  iblSpecularBrowserFile,
  transmissionBrowserFile,
  directLightBrowserFile,
  instancingStaticBrowserFile,
]);
const assetColdOwnerFiles = new Set([
  iblIrradianceBrowserFile,
  iblSpecularBrowserFile,
  transmissionBrowserFile,
]);
const instancingStaticBrowserGroupTimeoutMs = 900_000;
const browserSmokeShardIndex = 0;
const fixedSmokeShardWeight = 5;
const excludedDirectories = new Set(['.git', 'artifacts', 'dist', 'node_modules']);

function parsePositiveInt(value, name, { max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) {
    throw new Error(`${name} must be an integer from 1 to ${max}, got ${value}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const valueOptions = new Set([
    '--group-size',
    '--max-workers',
    '--shard-count',
    '--shard-index',
    '--shard-strategy',
  ]);
  const options = {
    dryRun: false,
    groupSize: defaultGroupSize,
    maxWorkers: defaultMaxWorkers,
    shardCount: defaultShardCount,
    shardIndex: defaultShardIndex,
    shardStrategy: defaultShardStrategy,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const [key, inlineValue] = argument.split('=', 2);
    const value = inlineValue ?? (valueOptions.has(key) ? argv[++index] : undefined);
    if (key === '--group-size') {
      options.groupSize = parsePositiveInt(value, '--group-size', { max: 24 });
    } else if (key === '--max-workers') {
      options.maxWorkers = parsePositiveInt(value, '--max-workers', { max: 6 });
    } else if (key === '--shard-count') {
      options.shardCount = parsePositiveInt(value, '--shard-count', { max: 32 });
    } else if (key === '--shard-index') {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0 || parsed > 31)
        throw new Error(`--shard-index must be an integer from 0 to 31, got ${value}`);
      options.shardIndex = parsed;
    } else if (key === '--shard-strategy') {
      if (value !== 'round-robin' && value !== 'balanced') {
        throw new Error(`--shard-strategy must be round-robin or balanced, got ${value}`);
      }
      options.shardStrategy = value;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  if (options.shardIndex >= options.shardCount)
    throw new Error(
      `--shard-index must be less than --shard-count, got ${options.shardIndex + 1}/${options.shardCount}`,
    );
  return options;
}

// Browser groups are intentionally ordered for readable logs, but a simple
// groupIndex % shardCount assignment can put the direct-light producer and
// render-target reflection on the same runner. The reference run showed one
// shard at ~20m while the other three finished in ~8m. Keep every test and
// process boundary, but place the known cold/large owners with a deterministic
// longest-processing-time scheduler so one runner cannot inherit the whole
// historical tail.
export function browserGroupWeight(group) {
  const joined = group.join('\n');
  let weight = 1;
  // Preview bootstraps a complete game project and the direct-light producer
  // renders eight paired captures. Their cold costs are large enough that
  // the two carriers must not be scheduled onto the same lane by LPT.
  if (joined.includes('apps/preview/')) weight += 3;
  if (joined.includes('direct-light.browser.test.ts')) weight += 5.2;
  if (joined.includes('render-target-reflection/')) weight += 2.4;
  if (joined.includes('extended-lighting/')) weight += 1.1;
  if (joined.includes('advanced-lighting/')) weight += 0.8;
  if (joined.includes('parity/color-lighting/src/visual/')) weight += 0.8;
  if (joined.includes('packages/render/src/__tests__/gpu-')) weight += 0.8;
  if (joined.includes('packages/runtime/src/__tests__/')) weight += 0.5;
  // The static-instancing acceptance submits 600 frames at 20k objects. Its
  // isolated process is intentionally much longer than an ordinary group;
  // model that cost so the longest-processing-time scheduler does not append
  // another renderer-heavy tail to the same shard.
  if (joined.includes(instancingStaticBrowserFile)) weight += 8;
  // A regular group pays one cold Vite/Chrome startup plus a small
  // per-file assertion cost. This keeps the scheduler stable when new files
  // are added without encoding a historical file-count ledger.
  weight += Math.max(0, group.length - 1) * 0.08;
  return weight;
}

export function assignBrowserGroupsToShards(
  groups,
  shardCount,
  strategy = defaultShardStrategy,
  { reserveSmoke = false } = {},
) {
  if (strategy === 'round-robin') {
    return groups.map((_group, groupIndex) => groupIndex % shardCount);
  }
  const totals = Array.from({ length: shardCount }, () => 0);
  const groupCounts = Array.from({ length: shardCount }, () => 0);
  const groupLimit = Math.ceil(groups.length / shardCount);
  const groupLimits = Array.from({ length: shardCount }, () => groupLimit);
  const assignment = Array(groups.length).fill(0);
  if (reserveSmoke && shardCount > browserSmokeShardIndex) {
    // Shard 0 still runs Vitest. Reserve two process slots for its fixed
    // MSAA/FXAA/multiplayer tail and let the other lanes absorb those light
    // groups. The smoke lane therefore gets two groups in the 16-group CI
    // plan while the other lanes may get five; this keeps the actual job wall
    // time bounded instead of pretending the fixed tail is free.
    totals[browserSmokeShardIndex] = fixedSmokeShardWeight;
    const smokeLimit = Math.max(1, groupLimit - 2);
    groupLimits[browserSmokeShardIndex] = smokeLimit;
    const nonSmokeLimit = Math.ceil((groups.length - smokeLimit) / Math.max(1, shardCount - 1));
    for (let shard = 0; shard < shardCount; shard += 1) {
      if (shard !== browserSmokeShardIndex) {
        groupLimits[shard] = Math.max(groupLimit, nonSmokeLimit);
      }
    }
  }
  const ranked = groups
    .map((group, index) => ({ index, weight: browserGroupWeight(group) }))
    .sort((left, right) => right.weight - left.weight || left.index - right.index);
  for (const { index, weight } of ranked) {
    let selected = -1;
    for (let shard = 0; shard < shardCount; shard += 1) {
      if (groupCounts[shard] >= groupLimits[shard]) continue;
      if (selected === -1 || totals[shard] < totals[selected]) selected = shard;
    }
    if (selected === -1) throw new Error('browser shard group capacity exhausted');
    assignment[index] = selected;
    totals[selected] += weight;
    groupCounts[selected] += 1;
  }
  return assignment;
}

function browserTestFiles(directory = rootDir, relativeDirectory = '') {
  const files = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      if (
        excludedDirectories.has(entry.name) ||
        relativePath === '.worktrees' ||
        relativePath === path.join('.claude', 'worktrees') ||
        relativePath.startsWith(`${path.join('.claude', 'worktrees')}${path.sep}`)
      ) {
        continue;
      }
      files.push(...browserTestFiles(path.join(directory, entry.name), relativePath));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith('.browser.test.ts') &&
      relativePath !== entityVisibilityBrowserTest
    ) {
      files.push(relativePath.split(path.sep).join('/'));
    }
  }
  return files;
}

function chunk(values, size) {
  const groups = [];
  for (let index = 0; index < values.length; index += size) {
    groups.push(values.slice(index, index + size));
  }
  return groups;
}

function planGroups(files, groupSize) {
  const preview = files.filter((file) => file.startsWith('apps/preview/'));
  const isolated = files.filter((file) => browserProcessIsolatedFiles.has(file));
  const regular = files.filter(
    (file) => !file.startsWith('apps/preview/') && !browserProcessIsolatedFiles.has(file),
  );

  // These owners create a real WebGPU device or a multi-pass pipeline whose
  // cold start has exceeded the ordinary Vitest budget on persistent runners.
  // Vitest's historical-duration scheduler can otherwise make their
  // app/renderer lifecycles contend with neighboring files. Each advanced
  // lighting owner gets its own fresh process: HDR, Bloom, deferred shading,
  // and SSAO all create multi-pass WebGPU pipelines, and sharing even two of
  // them has consumed the 60s test budget or stalled teardown before the app
  // became observable. The direct-light parity producer is also isolated: it
  // renders eight bounded captures (60 frames locally, 24 in the CI
  // lightweight profile) and keeps its own outer budget. Ordinary browser
  // files keep the caller-supplied bounded group size for throughput.
  const isolatedAdvancedLighting = isolated
    .filter((file) => advancedLightingBrowserFiles.has(file))
    .map((file) => [file]);
  // These three asset producers all use the on-demand Pack path and do not
  // own a long frame loop; share one process so their cold Vite startup is
  // paid once while the heavier renderer owners retain their boundaries.
  const assetColdOwners = isolated.filter((file) => assetColdOwnerFiles.has(file));
  const isolatedGroups = [
    ...isolatedAdvancedLighting,
    ...(assetColdOwners.length > 0 ? [assetColdOwners] : []),
    ...isolated
      .filter((file) => !advancedLightingBrowserFiles.has(file) && !assetColdOwnerFiles.has(file))
      .map((file) => [file]),
  ];
  return [
    ...(preview.length > 0 ? [preview] : []),
    ...isolatedGroups,
    ...chunk(regular, groupSize),
  ];
}

function resolveCliPath() {
  const candidates = [
    path.join(rootDir, 'node_modules/vitest/vitest.mjs'),
    path.join(rootDir, 'node_modules/vitest/dist/cli.js'),
  ];
  const cliPath = candidates.find((candidate) => existsSync(candidate));
  if (!cliPath) throw new Error('cannot resolve the workspace Vitest CLI');
  return cliPath;
}

export function withBrowserHeapLimit(environment) {
  const inherited = environment.NODE_OPTIONS?.trim() ?? '';
  if (/(^|\s)--max-old-space-size(?:=|\s)/.test(inherited)) return environment;
  return {
    ...environment,
    NODE_OPTIONS: [inherited, browserNodeHeapArg].filter(Boolean).join(' '),
  };
}

async function runGroup({ cliPath, group, groupIndex, groupCount, maxWorkers }) {
  process.stderr.write(`[vitest] browser group ${groupIndex}/${groupCount}: ${group.join(', ')}\n`);
  const previewGroup = group.some((file) => file.startsWith('apps/preview/'));
  const isolatedColdOwner = group.length === 1 && browserProcessIsolatedFiles.has(group[0]);
  const groupTimeoutMs = group.includes(instancingStaticBrowserFile)
    ? instancingStaticBrowserGroupTimeoutMs
    : group.includes(directLightBrowserFile)
      ? directLightBrowserGroupTimeoutMs
      : browserGroupTimeoutMs;
  // Isolated cold owners already have a fresh Vitest process and should not
  // pay the full Pack producer scan before importing their one SUT. Their
  // asset GUIDs are still validated by the same runtime import transport;
  // `on-demand` only moves the producer work behind the first real request.
  // Preview remains before-consume because its contract asserts a complete
  // template catalog before the consumer starts.
  const producerReadiness = previewGroup
    ? 'before-consume'
    : isolatedColdOwner || process.env.FORGEAX_BROWSER_PACK_READINESS === 'on-demand'
      ? 'on-demand'
      : 'before-consume';
  const command = [
    process.execPath,
    cliPath,
    'run',
    '--config',
    'vitest.browser.config.ts',
    '--project=browser',
    `--maxWorkers=${maxWorkers}`,
    ...group,
  ];
  const environment = withBrowserHeapLimit({
    ...process.env,
    FORGEAX_BROWSER_ENTITY_VISIBILITY: '0',
    FORGEAX_BROWSER_PACK_READINESS: producerReadiness,
    FORGEAX_TOOL_PREVIEW: '1',
  });
  const run = () =>
    runBrowserCommand(command, {
      cwd: rootDir,
      env: environment,
      timeoutMs: groupTimeoutMs,
      label: `Vitest browser group ${groupIndex}/${groupCount} files=${group.join(',')}`,
    });
  const first = await run();
  if (first.status === 0) return;
  if (!first.timedOut && !isRetryableOutput('vitest', first.output)) {
    throw new Error(
      `Vitest browser group ${groupIndex} failed with status ${first.status}; files=${group.join(', ')}`,
    );
  }

  process.stderr.write(
    `::warning::Vitest browser group ${groupIndex}/${groupCount} reported ${first.timedOut ? 'a bounded timeout' : 'declared runner instability'}; retrying only this group once with a fresh process\n`,
  );
  const second = await run();
  if (second.status !== 0) {
    throw new Error(
      `Vitest browser group ${groupIndex} failed after one isolated retry with status ${second.status}; files=${group.join(', ')}`,
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const files = browserTestFiles();
  if (!files.includes(r32floatCapabilityGenerationTest))
    files.push(r32floatCapabilityGenerationTest);
  const groups = planGroups(files, options.groupSize);
  if (groups.length === 0) throw new Error('no browser test files were discovered');
  const shardAssignment = assignBrowserGroupsToShards(
    groups,
    options.shardCount,
    options.shardStrategy,
    {
      reserveSmoke: process.env.FORGEAX_BROWSER_FIXED_SMOKE === '1',
    },
  );
  const selectedGroups = groups.filter(
    (_group, groupIndex) => shardAssignment[groupIndex] === options.shardIndex,
  );
  if (selectedGroups.length === 0) {
    throw new Error(
      `browser shard ${options.shardIndex + 1}/${options.shardCount} selected no groups from ${groups.length}`,
    );
  }

  if (options.dryRun) {
    for (const [index, group] of groups.entries()) {
      if (shardAssignment[index] !== options.shardIndex) continue;
      process.stdout.write(
        `group-${String(index + 1).padStart(2, '0')} (${group.length} files): ${group.join(', ')}\n`,
      );
    }
    return;
  }

  const cliPath = resolveCliPath();
  for (const [index, group] of groups.entries()) {
    if (shardAssignment[index] !== options.shardIndex) continue;
    await runGroup({
      cliPath,
      group,
      groupIndex: index + 1,
      groupCount: groups.length,
      maxWorkers: options.maxWorkers,
    });
  }
  process.stdout.write(
    `[vitest] split browser passed: groups=${groups.length}, selected=${selectedGroups.length}, files=${files.length}, shard=${options.shardIndex + 1}/${options.shardCount}, strategy=${options.shardStrategy}\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`[vitest] split browser failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}
