import { describe, expect, it } from 'vitest';
import {
  type MaterialShaderManifestEntry,
  selectHdrpPbrPrewarmVariants,
  selectProbePrewarmVariants,
  selectStandardPbrTransmissionPrewarmVariants,
} from '../assembly/factory.js';

const falseKey =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false';
const trueKey =
  'CLUSTER_FORWARD_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';
const probeFalseKey =
  'CLUSTER_FORWARD_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=false';
const probeTrueKey =
  'CLUSTER_FORWARD_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=true+VERTEX_COLOR_AVAILABLE=false';

function standardEntry(
  variants: readonly MaterialShaderManifestEntry['variants'][number][],
): MaterialShaderManifestEntry {
  return {
    identifier: 'forgeax::default-standard-pbr',
    sourcePath: 'default-standard-pbr.wgsl',
    composedWgsl: 'standard-default',
    paramSchema: '[]',
    variants,
  };
}

function variant(cluster: boolean, storage: boolean, projector?: boolean) {
  const defines = {
    CLUSTER_FORWARD_AVAILABLE: cluster,
    STORAGE_BUFFER_AVAILABLE: storage,
    VERTEX_COLOR_AVAILABLE: false,
    ...(projector === undefined ? {} : { PROJECTOR_AVAILABLE: projector }),
  };
  return {
    definesKey: Object.entries(defines)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([name, value]) => `${name}=${value}`)
      .join('+'),
    defines,
    composedWgsl: JSON.stringify(defines),
  };
}

function transmissionVariant(definesKey: string, transmission: boolean) {
  return {
    definesKey,
    defines: {
      CLUSTER_FORWARD_AVAILABLE: false,
      STORAGE_BUFFER_AVAILABLE: true,
      TRANSMISSION_AVAILABLE: transmission,
      VERTEX_COLOR_AVAILABLE: false,
    },
    composedWgsl: `standard-${transmission}`,
  };
}

function probeTransmissionVariant(definesKey: string, transmission: boolean) {
  const base = transmissionVariant(definesKey, transmission);
  return {
    ...base,
    defines: { ...base.defines, PROBE_BLEND_AVAILABLE: true },
  };
}

describe('Standard transmission exact-key prewarm selection', () => {
  it('returns both declared transmission variants', () => {
    const entry = standardEntry([
      transmissionVariant(falseKey, false),
      transmissionVariant(trueKey, true),
    ]);
    expect(
      selectStandardPbrTransmissionPrewarmVariants(entry, true).map((item) => item.definesKey),
    ).toEqual([falseKey, trueKey]);
  });

  it('rejects a missing exact transmission variant', () => {
    const entry = standardEntry([transmissionVariant(falseKey, false)]);
    expect(() => selectStandardPbrTransmissionPrewarmVariants(entry, true)).toThrow(
      'TRANSMISSION_AVAILABLE=true',
    );
  });
});

describe('HDRP PBR capability prewarm selection', () => {
  it('selects only the matching static capability/geometry state', () => {
    const entry = standardEntry([
      variant(true, true),
      variant(true, false),
      variant(false, true),
      variant(false, false),
    ]);
    expect(selectHdrpPbrPrewarmVariants(entry, true).map((item) => item.definesKey)).toEqual([
      variant(true, true).definesKey,
    ]);
    // Cluster-forward requires the storage-backed group(2) ABI. A device
    // without storage support must stay on the URP route and prewarm nothing.
    expect(selectHdrpPbrPrewarmVariants(entry, false)).toEqual([]);
  });

  it('respects an explicitly declared projector capability', () => {
    const entry = standardEntry([
      variant(true, true, true),
      variant(true, true, false),
      variant(true, true),
    ]);
    expect(
      selectHdrpPbrPrewarmVariants(entry, true, undefined, true).map((item) => item.definesKey),
    ).toEqual([variant(true, true, true).definesKey, variant(true, true).definesKey]);
  });
});

describe('probe material module prewarm capability selection', () => {
  it('keeps probe variants out of the fallback tier and matches device-owned axes', () => {
    const entry = standardEntry([
      probeTransmissionVariant(probeFalseKey, false),
      probeTransmissionVariant(probeTrueKey, true),
    ]);
    expect(selectProbePrewarmVariants(entry, false)).toEqual([]);
    expect(selectProbePrewarmVariants(entry, true).map((variant) => variant.definesKey)).toEqual([
      probeFalseKey,
      probeTrueKey,
    ]);
  });

  it('filters backend and sampled-texture axes but retains geometry/topology choices', () => {
    const goodKey =
      'CLUSTER_FORWARD_AVAILABLE=true+EXTENDED_LIGHTING_AVAILABLE=false+PROBE_BLEND_AVAILABLE=true+PROJECTOR_AVAILABLE=false+STORAGE_BUFFER_AVAILABLE=true+TRANSMISSION_AVAILABLE=false+VERTEX_COLOR_AVAILABLE=true';
    const wrongExtendedKey = goodKey.replace(
      'EXTENDED_LIGHTING_AVAILABLE=false',
      'EXTENDED_LIGHTING_AVAILABLE=true',
    );
    const wrongProjectorKey = goodKey.replace(
      'PROJECTOR_AVAILABLE=false',
      'PROJECTOR_AVAILABLE=true',
    );
    const wrongTransmissionKey = goodKey.replace(
      'TRANSMISSION_AVAILABLE=false',
      'TRANSMISSION_AVAILABLE=true',
    );
    const variant = (definesKey: string, defines: Record<string, boolean>) => ({
      definesKey,
      defines,
      composedWgsl: definesKey,
    });
    const baseDefines = {
      CLUSTER_FORWARD_AVAILABLE: true,
      EXTENDED_LIGHTING_AVAILABLE: false,
      PROBE_BLEND_AVAILABLE: true,
      PROJECTOR_AVAILABLE: false,
      STORAGE_BUFFER_AVAILABLE: true,
      TRANSMISSION_AVAILABLE: false,
      VERTEX_COLOR_AVAILABLE: true,
    };
    const selected = selectProbePrewarmVariants(
      standardEntry([
        variant(goodKey, baseDefines),
        variant(wrongExtendedKey, { ...baseDefines, EXTENDED_LIGHTING_AVAILABLE: true }),
        variant(wrongProjectorKey, { ...baseDefines, PROJECTOR_AVAILABLE: true }),
        variant(wrongTransmissionKey, { ...baseDefines, TRANSMISSION_AVAILABLE: true }),
      ]),
      true,
      false,
      false,
      true,
      false,
    );
    expect(selected.map((candidate) => candidate.definesKey)).toEqual([goodKey]);
  });
});
