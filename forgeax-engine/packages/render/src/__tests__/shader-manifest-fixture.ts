import {
  DEFAULT_STANDARD_PBR_PARAM_SCHEMA,
  DEFAULT_UNLIT_PARAM_SCHEMA,
} from '@forgeax/engine-shader';

type FixtureEntry = {
  readonly hash: string;
  readonly wgsl: string;
  readonly glsl: string;
  readonly bindings: string;
};

const pbrWgsl = '// fixture marker: f_schlick\n';
const unlitWgsl = '// fixture marker: default-unlit\n';

const entries: readonly FixtureEntry[] = [
  { hash: 'fixture-pbr', wgsl: pbrWgsl, glsl: '', bindings: '[]' },
  { hash: 'fixture-unlit', wgsl: unlitWgsl, glsl: '', bindings: '[]' },
  {
    hash: 'fixture-tonemap',
    wgsl: '// fixture marker: TonemapParams\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-taa',
    wgsl: '// fixture marker: fs_taa_resolve\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-fxaa',
    wgsl: '// fixture marker: rgb2luma\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-bloom-bright',
    wgsl: '// fixture marker: BloomBrightParams\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-bloom-blur',
    wgsl: '// fixture marker: BloomBlurParams\n',
    glsl: '',
    bindings: '[]',
  },
  {
    hash: 'fixture-bloom-composite',
    wgsl: '// fixture marker: BloomCompositeParams\n',
    glsl: '',
    bindings: '[]',
  },
];

const standardPbrVariants = (() => {
  const variants = [];
  for (const cluster of [false, true]) {
    for (const storage of [false, true]) {
      for (const vertexColor of [false, true]) {
        const defines = {
          CLUSTER_FORWARD_AVAILABLE: cluster,
          STORAGE_BUFFER_AVAILABLE: storage,
          VERTEX_COLOR_AVAILABLE: vertexColor,
        };
        const sortedDefines = Object.entries(defines).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0,
        );
        const definesKey = sortedDefines.every(([, value]) => value)
          ? ''
          : sortedDefines.map(([key, value]) => `${key}=${value}`).join('+');
        variants.push({ definesKey, defines, composedWgsl: pbrWgsl });
      }
    }
  }
  return variants;
})();

const materialShaders = [
  {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'fixture://forgeax/default-standard-pbr.wgsl',
    composedWgsl: pbrWgsl,
    paramSchema: JSON.stringify(DEFAULT_STANDARD_PBR_PARAM_SCHEMA),
    variants: standardPbrVariants,
    uvSetCount: 8,
  },
  {
    identifier: 'forgeax::default-unlit',
    sourcePath: 'fixture://forgeax/default-unlit.wgsl',
    composedWgsl: unlitWgsl,
    paramSchema: JSON.stringify(DEFAULT_UNLIT_PARAM_SCHEMA),
    variants: [],
    uvSetCount: 1,
  },
] as const;

/**
 * Build the smallest manifest that exercises renderer post-process assembly.
 * The fixture is intentionally self-contained so package tests do not depend
 * on a generated app dist directory or on the caller's working directory.
 */
export function renderLifecycleManifestUrl(): string {
  return `data:application/json,${encodeURIComponent(
    JSON.stringify({ entries, materialShaders }),
  )}`;
}
