import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateCookedMaterialRecord } from '@forgeax/engine-pack/material-cook';
import type { MaterialAsset } from '@forgeax/engine-types';
import { beforeAll, expect, it } from 'vitest';
import { createMaterialPackCooker } from '../pack-cooker.js';

async function buildPublicationScenario() {
  const root = await mkdtemp(join(tmpdir(), 'material-program-publication-'));
  try {
    for (const [name, factor] of [
      ['first', 1],
      ['second', 2],
    ] as const) {
      await writeFile(
        join(root, `${name}.wgsl`),
        `#define_import_path game::${name}
#import forgeax_material::parameters::{material}
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0, 0.0, 0.0, 1.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return material.baseColor * ${factor}.0; }
`,
      );
    }
    const source: MaterialAsset = {
      kind: 'material',
      parameters: [{ name: 'baseColor', type: 'vec4' }],
      values: { baseColor: [1, 0, 0, 1] },
      passes: [
        {
          name: 'Forward',
          program: { module: 'game::first', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
        },
        {
          name: 'Overlay',
          program: { module: 'game::second', vertexEntry: 'vs_main', fragmentEntry: 'fs_main' },
        },
      ],
    };
    const cooker = createMaterialPackCooker([root]);
    const first = await cooker.cook({ guid: 'first-root', source });
    const record = validateCookedMaterialRecord(
      (first.payload as { cooked: unknown }).cooked,
    ).unwrap();
    const second = await cooker.cook({
      guid: 'second-root',
      source: { ...source, values: { baseColor: [0, 1, 0, 1] } },
    });
    const changed = validateCookedMaterialRecord(
      (second.payload as { cooked: unknown }).cooked,
    ).unwrap();
    return { first, record, changed };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

let scenario: Awaited<ReturnType<typeof buildPublicationScenario>>;

beforeAll(async () => {
  scenario = await buildPublicationScenario();
});

it('publishes one program per pass with independent module artifacts', () => {
  expect(scenario.record.programs).toHaveLength(2);
  expect(Object.keys(scenario.first.artifacts)).toHaveLength(2);
  expect(
    scenario.record.programs.map((program) =>
      program.selections.map((selection) => selection.pass),
    ),
  ).toEqual([['Forward'], ['Overlay']]);
});

it('keeps specialization keys distinct for independent pass modules', () => {
  expect(new Set(scenario.record.programs.map((program) => program.specializationKey)).size).toBe(
    2,
  );
});

it('reuses programs across GUIDs while changing material publication identity', () => {
  expect(scenario.changed.programs).toEqual(scenario.record.programs);
  expect(scenario.changed.receipt.identity.materialPublicationIdentity).not.toBe(
    scenario.record.receipt.identity.materialPublicationIdentity,
  );
});
