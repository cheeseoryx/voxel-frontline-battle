import { describe, expect, it } from 'vitest';
import { cookMaterialAsset } from '../cook.js';
import { buildMaterialSourceCatalog } from '../source-catalog.js';

const source = `#define_import_path test::entries
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
}
@vertex fn vs_main() -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(0.0, 0.0, 0.0, 1.0);
  output.color = vec4<f32>(1.0);
  return output;
}
@fragment fn fs_main(@location(0) color: vec4<f32>) -> @location(0) vec4<f32> {
  return color;
}
@fragment fn fs_wrong_input(@location(0) color: vec3<f32>) -> @location(0) vec4<f32> {
  return vec4<f32>(color, 1.0);
}
`;

async function cook(
  vertexEntry: string,
  fragmentEntry: string | undefined,
  moduleSource = source,
  passName = 'Forward',
) {
  const sources = buildMaterialSourceCatalog({
    engine: [],
    project: [{ path: 'entries.wgsl', source: moduleSource }],
  });
  if (!sources.ok) throw sources.error;
  return cookMaterialAsset({
    material: 'entry-validation',
    table: {
      'entry-validation': {
        kind: 'material',
        parameters: [],
        passes: [
          {
            name: passName,
            program: {
              module: 'test::entries',
              vertexEntry,
              ...(fragmentEntry === undefined ? {} : { fragmentEntry }),
            },
          },
        ],
      },
    },
    sources: sources.value,
  });
}

describe('selected material graphics entries', () => {
  it('accepts a matching stage pair', async () => {
    expect((await cook('vs_main', 'fs_main')).ok).toBe(true);
  });

  it.each([
    ['Forward', 'fs_main'],
    ['Deferred', 'fs_gbuffer'],
    ['ShadowCaster', 'fs_shadow'],
  ])('validates the implicit %s fragment entry', async (passName, fragment) => {
    const matchingSource = source.replace('fn fs_main(', `fn ${fragment}(`);
    expect((await cook('vs_main', undefined, matchingSource, passName)).ok).toBe(true);
    const result = await cook(
      'vs_main',
      undefined,
      source.replace('fn fs_main(', 'fn fs_other('),
      passName,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.message).toContain(`fragment entry '${fragment}'`);
  });

  it.each([
    ['vs_missing', 'fs_main', "vertex entry 'vs_missing'"],
    ['vs_main', 'fs_missing', "fragment entry 'fs_missing'"],
    ['fs_main', 'fs_main', "vertex entry 'fs_main'"],
    ['vs_main', 'vs_main', "fragment entry 'vs_main'"],
    ['vs_main', 'fs_wrong_input', '@location(0)'],
  ])('rejects %s / %s before publication', async (vertex, fragment, diagnostic) => {
    const result = await cook(vertex, fragment);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('shader-compile-failed');
    expect(result.error.message).toContain(diagnostic);
  });
});
