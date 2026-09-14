import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { assignBrowserGroupsToShards, browserGroupWeight } from '../run-split-vitest-browser.mjs';

function dryRunGroups(groupSize = 8) {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/ci/run-split-vitest-browser.mjs',
      '--dry-run',
      `--group-size=${groupSize}`,
      '--shard-count=1',
      '--shard-index=0',
    ],
    { cwd: process.cwd(), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.slice(line.indexOf(': ') + 2).split(', '));
}

test('SSAO onerror gate keeps a bounded lavapipe cold-start budget', () => {
  const source = readFileSync(
    'apps/learn-render/5.advanced-lighting/9.ssao/src/__tests__/onerror-gate.browser.test.ts',
    'utf8',
  );
  assert.match(source, /onerrorGate\('learn-render 5\.9 ssao',[\s\S]*90_000\)/);
});

test('preview browser owners are isolated from ordinary bounded groups', () => {
  const groups = dryRunGroups();
  const previewGroup = groups.find((group) =>
    group.some((file) => file.startsWith('apps/preview/')),
  );
  assert.ok(previewGroup);
  assert.deepEqual(previewGroup, ['apps/preview/__tests__/preview.browser.test.ts']);

  const regularGroups = groups.filter((group) => group !== previewGroup);
  assert.ok(regularGroups.every((group) => group.length <= 8));

  const files = groups.flat();
  assert.equal(new Set(files).size, files.length, 'a browser test may belong to only one group');
});

test('advanced lighting browser owners retain dedicated process boundaries', () => {
  const groups = dryRunGroups();
  const lifecycleHeavy = groups.filter((group) =>
    group.some((file) =>
      /apps\/learn-render\/5\.advanced-lighting\/(?:6\.hdr|7\.bloom|8\.deferred-shading|9\.ssao)\//.test(
        file,
      ),
    ),
  );
  assert.equal(lifecycleHeavy.length, 4);
  assert.ok(lifecycleHeavy.every((group) => group.length === 1));
  assert.deepEqual(
    lifecycleHeavy
      .map(
        (group) =>
          group[0]?.match(
            /5\.advanced-lighting\/(?:6\.hdr|7\.bloom|8\.deferred-shading|9\.ssao)\//,
          )?.[0],
      )
      .sort(),
    [
      '5.advanced-lighting/6.hdr/',
      '5.advanced-lighting/7.bloom/',
      '5.advanced-lighting/8.deferred-shading/',
      '5.advanced-lighting/9.ssao/',
    ],
  );
  assert.equal(
    lifecycleHeavy.filter((group) => group.some((file) => file.includes('/7.bloom/'))).length,
    1,
  );
  const cheapOwner = groups.find((group) =>
    group.includes('packages/app/__tests__/thin-wrapper.browser.test.ts'),
  );
  assert.ok(cheapOwner);
  assert.ok(cheapOwner.length > 1, 'contract-only owners should share the regular process');
});

test('large instancing acceptance owns an isolated long-lived group', () => {
  const target = 'apps/parity/instancing-static/src/__tests__/instances.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(target)),
    [[target]],
  );

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /instancingStaticBrowserFile/);
  assert.match(browserRunner, /instancingStaticBrowserGroupTimeoutMs = 900_000/);
  assert.match(browserRunner, /group\.includes\(instancingStaticBrowserFile\)/);
});

test('IBL demos share one bounded on-demand producer boundary', () => {
  const groups = dryRunGroups();
  const iblFiles = [
    'apps/learn-render/6.pbr/2.ibl-irradiance/src/__tests__/onerror-gate.browser.test.ts',
    'apps/learn-render/6.pbr/3.ibl-specular/src/__tests__/onerror-gate.browser.test.ts',
  ];
  const iblGroup = groups.find((group) => group.includes(iblFiles[0]));
  assert.deepEqual(iblGroup, [
    ...iblFiles,
    'apps/learn-render/6.pbr/4.transmission-refraction/src/__tests__/onerror-gate.browser.test.ts',
  ]);
  assert.ok(iblFiles.every((file) => iblGroup.includes(file)));

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /iblIrradianceBrowserFile/);
  assert.match(browserRunner, /iblSpecularBrowserFile/);
  assert.match(browserRunner, /isolatedColdOwner\s*\|\|\s*process\.env/);
  assert.doesNotMatch(browserRunner, /advancedLightingSingleton/);
});

test('direct-light browser producer owns an isolated long-lived group', () => {
  const directLightFile =
    'apps/parity/color-lighting/cases/direct-light/__tests__/direct-light.browser.test.ts';
  const groups = dryRunGroups();
  assert.deepEqual(
    groups.filter((group) => group.includes(directLightFile)),
    [[directLightFile]],
  );

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /directLightBrowserFile/);
  assert.match(browserRunner, /directLightBrowserGroupTimeoutMs = 420_000/);
  assert.match(browserRunner, /group\.includes\(directLightBrowserFile\)/);
});

test('asset-heavy browser owners use isolated cold processes for Pack readiness', () => {
  const groups = dryRunGroups();
  const assetHeavyOwners = groups.filter((group) =>
    group.some((file) =>
      /apps\/learn-render\/6\.pbr\/(?:2\.ibl-irradiance|3\.ibl-specular|4\.transmission-refraction)\//.test(
        file,
      ),
    ),
  );
  assert.equal(assetHeavyOwners.length, 1);
  assert.equal(assetHeavyOwners[0].length, 3);
  assert.match(
    readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8'),
    /assetColdOwnerFiles/,
  );
});

test('r32float generation integration is projected into exactly one browser group', () => {
  const target =
    'packages/rhi-webgpu/src/__tests__/r32float-capability-generation.integration.test.ts';
  const groups = dryRunGroups();
  const matchingGroups = groups.filter((group) => group.includes(target));
  assert.equal(matchingGroups.length, 1);
  assert.equal(groups.flat().filter((file) => file === target).length, 1);

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /r32floatCapabilityGenerationTest/);
});

test('CI browser shards use deterministic cost balancing without dropping groups', () => {
  const groups = dryRunGroups();
  const assignment = assignBrowserGroupsToShards(groups, 4, 'balanced');
  assert.equal(assignment.length, groups.length);
  assert.ok(assignment.every((shard) => Number.isInteger(shard) && shard >= 0 && shard < 4));

  const totals = [0, 0, 0, 0];
  for (const [index, group] of groups.entries())
    totals[assignment[index]] += browserGroupWeight(group);
  const instancing = groups.findIndex((group) =>
    group.includes('apps/parity/instancing-static/src/__tests__/instances.browser.test.ts'),
  );
  assert.ok(Math.max(...totals) - Math.min(...totals) < 2, `imbalanced weights: ${totals}`);
  assert.notEqual(instancing, -1);

  const directLight = groups.findIndex((group) =>
    group.some((file) => file.includes('direct-light')),
  );
  const reflection = groups.findIndex((group) =>
    group.some((file) => file.includes('render-target-reflection')),
  );
  assert.notEqual(directLight, -1);
  assert.notEqual(reflection, -1);
  assert.notEqual(assignment[directLight], assignment[reflection]);

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /--shard-strategy/);
  assert.match(browserRunner, /strategy=\$\{options\.shardStrategy\}/);
});

test('fixed smoke is budgeted while all four Vitest lanes stay productive', () => {
  const groups = dryRunGroups();
  const assignment = assignBrowserGroupsToShards(groups, 4, 'balanced', { reserveSmoke: true });
  assert.deepEqual(
    [0, 1, 2, 3].map((shard) => assignment.filter((value) => value === shard).length > 0),
    [true, true, true, true],
  );

  const preview = groups.findIndex((group) =>
    group.some((file) => file.startsWith('apps/preview/')),
  );
  const directLight = groups.findIndex((group) =>
    group.some((file) => file.includes('direct-light')),
  );
  assert.notEqual(preview, -1);
  assert.notEqual(directLight, -1);
  assert.notEqual(assignment[directLight], assignment[preview]);

  const totals = Array(4).fill(0);
  for (const [index, group] of groups.entries())
    totals[assignment[index]] += browserGroupWeight(group);
  assert.ok(
    Math.max(...totals) - Math.min(...totals) < 9,
    `imbalanced smoke-aware weights: ${totals}`,
  );

  const browserRunner = readFileSync('scripts/ci/run-split-vitest-browser.mjs', 'utf8');
  assert.match(browserRunner, /fixedSmokeShardWeight/);
  assert.match(browserRunner, /browserSmokeShardIndex/);
});

test('four-lane CI plan reserves two fresh-process slots for the smoke tail', () => {
  const groups = dryRunGroups(16);
  const assignment = assignBrowserGroupsToShards(groups, 4, 'balanced', { reserveSmoke: true });
  const counts = [0, 0, 0, 0];
  for (const shard of assignment) counts[shard] += 1;
  assert.ok(counts.every((count) => count > 0));
  assert.ok(counts[0] <= 2, `smoke tail was not reserved: ${counts}`);
  assert.ok(Math.max(...counts) <= 5, `too many cold groups: ${counts}`);
});

test('fixed-smoke shard remains a real Vitest lane', () => {
  const result = spawnSync(
    process.execPath,
    [
      'scripts/ci/run-split-vitest-browser.mjs',
      '--dry-run',
      '--group-size=8',
      '--shard-strategy=balanced',
      '--shard-index=0',
      '--shard-count=4',
    ],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, FORGEAX_BROWSER_FIXED_SMOKE: '1' },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /owns fixed post-Vitest smoke work/);
  assert.match(result.stdout, /^group-/m);
});
