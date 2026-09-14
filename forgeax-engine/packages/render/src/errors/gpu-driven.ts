import type { MaterialShaderArtifactReceipt } from '@forgeax/engine-shader';

export type GpuDrivenPreparationErrorCode =
  | 'missing-material-receipt'
  | 'missing-uv'
  | 'reflection-mismatch'
  | 'vertex-input-mismatch'
  | 'alpha-mask-mismatch'
  | 'resource-not-ready'
  | 'stale-generation'
  | 'skin-receipt-mismatch';

export type GpuDrivenPreparationReason =
  | 'material-receipt-missing'
  | 'uv-set-missing'
  | 'reflection-receipt-mismatch'
  | 'vertex-semantic-mismatch'
  | 'alpha-mask-receipt-missing'
  | 'material-resource-missing'
  | 'generation-stale'
  | 'skin-address-missing';

export interface GpuDrivenPreparationErrorDetail {
  readonly reason: GpuDrivenPreparationReason;
  readonly owner: 'material' | 'geometry' | 'skin' | 'generation';
  readonly expected?: string;
  readonly actual?: string;
  readonly expectedGeneration?: number;
  readonly actualGeneration?: number;
}

const ERROR_POLICY: Readonly<
  Record<GpuDrivenPreparationErrorCode, { readonly expected: string; readonly hint: string }>
> = {
  'missing-material-receipt': {
    expected: 'a producer-owned Standard PBR material receipt is present',
    hint: 'cook and load the Standard PBR artifact, then retry preparation',
  },
  'missing-uv': {
    expected: 'the geometry exposes every UV set named by the material receipt',
    hint: 'repair the geometry UV semantic or route the draw to the CPU semantic lane',
  },
  'reflection-mismatch': {
    expected: 'the loaded reflection receipt matches the artifact layout identity',
    hint: 'rebuild the material artifact and reflection from one source, then retry',
  },
  'vertex-input-mismatch': {
    expected: 'geometry vertex semantics match the material reflection receipt',
    hint: 'repair the geometry vertex semantic layout or route the draw to the CPU lane',
  },
  'alpha-mask-mismatch': {
    expected: 'the Alpha Mask cutoff is present in the material receipt',
    hint: 'declare alphaCutoff in the Standard PBR material schema and recook it',
  },
  'resource-not-ready': {
    expected: 'all material resource slots have resolved handles',
    hint: 'resolve the declared texture and sampler resources before recording',
  },
  'stale-generation': {
    expected: 'receipt and prepared inputs belong to the requested generation',
    hint: 'discard stale GPU facts, rebuild the producer receipt, and retry the same draw',
  },
  'skin-receipt-mismatch': {
    expected: 'skinned geometry has a current palette address receipt',
    hint: 'rebuild the Skin palette receipt for this generation before recording',
  },
};

export class GpuDrivenPreparationError extends Error {
  readonly code: GpuDrivenPreparationErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: GpuDrivenPreparationErrorDetail;

  constructor(code: GpuDrivenPreparationErrorCode, detail: GpuDrivenPreparationErrorDetail) {
    const policy = ERROR_POLICY[code];
    super(`[GpuDrivenPreparationError ${code}] ${policy.expected}`);
    this.name = 'GpuDrivenPreparationError';
    this.code = code;
    this.expected = policy.expected;
    this.hint = policy.hint;
    this.detail = detail;
  }
}

export interface GpuDrivenPreparedMaterial {
  readonly receipt: MaterialShaderArtifactReceipt;
  readonly resourceSlots: MaterialShaderArtifactReceipt['resourceSlots'];
  readonly uvSets: MaterialShaderArtifactReceipt['uvSets'];
  readonly vertexInputs: MaterialShaderArtifactReceipt['vertexInputs'];
  readonly alphaMask: MaterialShaderArtifactReceipt['alphaMask'];
}
