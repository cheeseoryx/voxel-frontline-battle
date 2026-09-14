/**
 * Consumer-only SSR M0 admission.
 *
 * This module consumes detached producer receipts. It owns no capture,
 * device, graph, or recovery handle and therefore cannot repair a missing
 * producer. A complete receipt set is the only route to an admitted result.
 */

import {
  type RhiTextureFormatCapabilityReceipt,
  validateR32FloatReceipt,
} from '@forgeax/engine-rhi';
import type { ReflectionFallbackReceipt } from '../inspection-types';
import type { SsrOwnerRecoveryAction } from './errors';
import type { SsrAdmissionIdentity } from './identity';

export const SSR_FORMAT_PROFILE = 'r32float-mip-sampled-storage' as const;

export const SSR_FORMAT_STAGES = Object.freeze([
  'texture-create',
  'mip-view',
  'sampled-storage-bind-group',
  'pipeline-bind',
  'finish',
  'submit',
  'completion',
  'readback',
] as const);

export type { SsrAdmissionIdentity } from './identity';

export type SsrFormatStage = (typeof SSR_FORMAT_STAGES)[number];

/**
 * The admission input is the real renderer owner receipt plus the one
 * integration identity supplied by the host. It deliberately does not
 * recreate submitted/source/LKG boolean flags.
 */
export type SsrReflectionFallbackReceipt = ReflectionFallbackReceipt & {
  readonly identity: SsrAdmissionIdentity;
};

/** RHI capability receipt with the same host-supplied integration identity. */
export type SsrFormatReceipt = RhiTextureFormatCapabilityReceipt & {
  readonly identity: SsrAdmissionIdentity;
};

export interface SsrTemporalReceipt {
  readonly identity: SsrAdmissionIdentity;
  readonly successfulSubmit: true;
  readonly generation: number;
}

export interface SsrAdmissionWork {
  readonly attachmentCount: number;
  readonly passCount: number;
  readonly bindingCount: number;
  readonly resourceCount: number;
  readonly historyCount: 0;
  readonly temporalDemand: 0;
}

export interface SsrAdmissionBudget {
  readonly probeExecutions: 0 | 1;
  readonly resetCount: 0;
  readonly rebuildCount: 0;
}

export interface SsrAdmissionFailure {
  readonly code:
    | 'ssr-not-requested'
    | 'ssr-reflection-fallback-unavailable'
    | 'ssr-format-unavailable'
    | 'ssr-temporal-unavailable'
    | 'ssr-receipt-identity-mismatch'
    | 'ssr-receipt-stale';
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<{
    readonly owner: 'producer' | 'format' | 'temporal' | 'consumer';
    /** Owner-directed action an AI consumer can take without parsing hint text. */
    readonly action: SsrOwnerRecoveryAction;
    readonly generation?: number;
    readonly identityField?: keyof SsrAdmissionIdentity;
  }>;
}

export type SsrAdmissionResult =
  | {
      readonly status: 'admitted';
      readonly identity: SsrAdmissionIdentity | undefined;
      readonly generation: number;
      readonly work: SsrAdmissionWork;
      readonly budget: SsrAdmissionBudget;
      readonly failure?: undefined;
    }
  | {
      readonly status: 'fallback-only';
      readonly identity: SsrAdmissionIdentity | undefined;
      readonly generation: number;
      readonly work: SsrAdmissionWork;
      readonly budget: SsrAdmissionBudget;
      readonly failure: SsrAdmissionFailure;
    };

export interface SsrAdmissionInput {
  readonly requested: boolean;
  readonly identity: SsrAdmissionIdentity;
  readonly reflectionFallback?: SsrReflectionFallbackReceipt;
  readonly format?: SsrFormatReceipt;
  readonly temporal?: SsrTemporalReceipt;
  readonly previousGeneration?: number;
}

/** Public renderer projection consumed by the parent SSR feature. */
export interface SsrDependenciesInspection {
  readonly status: 'admitted' | 'fallback-only';
  /** Absent until the host binds an exact source/tree/lock/build identity. */
  readonly identity: SsrAdmissionIdentity | undefined;
  readonly requested: boolean;
  readonly reflectionFallback: ReflectionFallbackReceipt | undefined;
  readonly format: SsrFormatReceipt | undefined;
  readonly temporal: SsrTemporalReceipt | undefined;
  readonly admission: SsrAdmissionResult;
  readonly work: SsrAdmissionWork;
  readonly budget: SsrAdmissionBudget;
  readonly failure: SsrAdmissionFailure | undefined;
}

const ZERO_WORK: SsrAdmissionWork = Object.freeze({
  attachmentCount: 0,
  passCount: 0,
  bindingCount: 0,
  resourceCount: 0,
  historyCount: 0,
  temporalDemand: 0,
});

const ADMITTED_WORK: SsrAdmissionWork = Object.freeze({
  attachmentCount: 1,
  passCount: 1,
  bindingCount: 1,
  resourceCount: 1,
  historyCount: 0,
  temporalDemand: 0,
});

const ZERO_BUDGET: SsrAdmissionBudget = Object.freeze({
  probeExecutions: 0,
  resetCount: 0,
  rebuildCount: 0,
});

const ADMITTED_BUDGET: SsrAdmissionBudget = Object.freeze({
  probeExecutions: 1,
  resetCount: 0,
  rebuildCount: 0,
});

function identityFieldMismatch(
  expected: SsrAdmissionIdentity,
  actual: SsrAdmissionIdentity,
): keyof SsrAdmissionIdentity | undefined {
  for (const field of ['sourceHead', 'sourceTree', 'lockSha256', 'buildSha256'] as const) {
    if (expected[field] !== actual[field]) return field;
  }
  return undefined;
}

function blocked(
  identity: SsrAdmissionIdentity | undefined,
  failure: SsrAdmissionFailure,
  generation = 0,
): SsrAdmissionResult {
  return Object.freeze({
    status: 'fallback-only',
    identity,
    generation,
    work: ZERO_WORK,
    budget: ZERO_BUDGET,
    failure,
  });
}

function failure(
  code: SsrAdmissionFailure['code'],
  owner: SsrAdmissionFailure['detail']['owner'],
  hint: string,
  detail: Omit<SsrAdmissionFailure['detail'], 'owner' | 'action'> = {},
): SsrAdmissionFailure {
  const action: SsrOwnerRecoveryAction = recoveryActionFor(code);
  return Object.freeze({
    code,
    expected: 'all producer, format, and temporal receipts share one admitted identity',
    hint,
    detail: Object.freeze({ owner, action, ...detail }),
  });
}

function recoveryActionFor(code: SsrAdmissionFailure['code']): SsrOwnerRecoveryAction {
  switch (code) {
    case 'ssr-reflection-fallback-unavailable':
    case 'ssr-receipt-identity-mismatch':
      return 'rebuild';
    case 'ssr-not-requested':
    case 'ssr-format-unavailable':
    case 'ssr-temporal-unavailable':
    case 'ssr-receipt-stale':
      return 'retry';
  }
}

function receiptFailure(
  input: SsrAdmissionInput,
  receipt: { readonly identity: SsrAdmissionIdentity },
  owner: SsrAdmissionFailure['detail']['owner'],
): SsrAdmissionResult | undefined {
  const field = identityFieldMismatch(input.identity, receipt.identity);
  if (field === undefined) return undefined;
  return blocked(
    input.identity,
    failure('ssr-receipt-identity-mismatch', owner, 'rebuild the owner receipt for this identity', {
      identityField: field,
    }),
  );
}

function validFallback(receipt: SsrReflectionFallbackReceipt | undefined): boolean {
  return (
    receipt !== undefined &&
    receipt.candidateVisible === false &&
    Number.isFinite(receipt.coverage) &&
    receipt.coverage >= 0 &&
    receipt.coverage <= 1 &&
    (receipt.sourceKey === undefined || receipt.sourceKey.length > 0) &&
    (receipt.extent === undefined ||
      (receipt.extent.length === 3 &&
        receipt.extent.every((value) => Number.isFinite(value) && value > 0))) &&
    Number.isInteger(receipt.sourceGeneration) &&
    receipt.sourceGeneration >= 0 &&
    Number.isInteger(receipt.projectionGeneration) &&
    receipt.projectionGeneration >= 0 &&
    Number.isInteger(receipt.deviceGeneration) &&
    receipt.deviceGeneration >= 0 &&
    receipt.brdfSignature === 'standard-pbr-ibl-v1' &&
    ((receipt.source === 'probe' && (receipt.state === 'active' || receipt.state === 'lkg')) ||
      (receipt.source === 'skylight' && (receipt.state === 'active' || receipt.state === 'lkg')) ||
      (receipt.source === 'neutral' && receipt.state === 'neutral'))
  );
}

function validFormat(receipt: SsrFormatReceipt | undefined): boolean {
  if (
    receipt?.profile !== SSR_FORMAT_PROFILE ||
    receipt.verdict !== 'admitted' ||
    receipt.evidence !== 'real' ||
    !Number.isInteger(receipt.deviceGeneration) ||
    receipt.deviceGeneration < 0
  ) {
    return false;
  }
  if (
    !SSR_FORMAT_STAGES.every((stage) =>
      receipt.stages.some((entry) => entry.stage === stage && entry.verdict === 'admitted'),
    )
  ) {
    return false;
  }
  return validateR32FloatReceipt(receipt).ok;
}

function validTemporal(receipt: SsrTemporalReceipt | undefined): boolean {
  return (
    receipt?.successfulSubmit === true &&
    Number.isInteger(receipt.generation) &&
    receipt.generation >= 0
  );
}

export function admitSsrM0(input: SsrAdmissionInput): SsrAdmissionResult {
  if (!input.requested) {
    return blocked(
      input.identity,
      failure('ssr-not-requested', 'consumer', 'request SSR before evaluating M0 admission'),
    );
  }
  if (input.reflectionFallback === undefined) {
    return blocked(
      input.identity,
      failure('ssr-reflection-fallback-unavailable', 'producer', 'use LKG, Skylight, or neutral'),
    );
  }
  const fallbackIdentityFailure = receiptFailure(input, input.reflectionFallback, 'producer');
  if (fallbackIdentityFailure !== undefined) return fallbackIdentityFailure;
  if (!validFallback(input.reflectionFallback)) {
    return blocked(
      input.identity,
      failure(
        'ssr-reflection-fallback-unavailable',
        'producer',
        'inspect and rebuild the producer receipt',
      ),
      input.reflectionFallback.projectionGeneration,
    );
  }
  if (input.format === undefined) {
    return blocked(
      input.identity,
      failure('ssr-format-unavailable', 'format', 'probe the exact format profile for this device'),
      input.reflectionFallback.projectionGeneration,
    );
  }
  const formatIdentityFailure = receiptFailure(input, input.format, 'format');
  if (formatIdentityFailure !== undefined) return formatIdentityFailure;
  if (!validFormat(input.format)) {
    return blocked(
      input.identity,
      failure('ssr-format-unavailable', 'format', 'complete the full r32float profile probe'),
      input.reflectionFallback.projectionGeneration,
    );
  }
  if (input.temporal === undefined) {
    return blocked(
      input.identity,
      failure(
        'ssr-temporal-unavailable',
        'temporal',
        'submit the matching temporal producer receipt',
      ),
      input.reflectionFallback.projectionGeneration,
    );
  }
  const temporalIdentityFailure = receiptFailure(input, input.temporal, 'temporal');
  if (temporalIdentityFailure !== undefined) return temporalIdentityFailure;
  if (!validTemporal(input.temporal)) {
    return blocked(
      input.identity,
      failure('ssr-temporal-unavailable', 'temporal', 'inspect and rebuild the temporal receipt'),
      input.reflectionFallback.projectionGeneration,
    );
  }
  if (
    input.previousGeneration !== undefined &&
    input.previousGeneration !== input.reflectionFallback.projectionGeneration
  ) {
    return blocked(
      input.identity,
      failure(
        'ssr-receipt-stale',
        'consumer',
        'discard stale completion and reinspect the owners',
        {
          generation: input.reflectionFallback.projectionGeneration,
        },
      ),
      input.reflectionFallback.projectionGeneration,
    );
  }
  return Object.freeze({
    status: 'admitted',
    identity: input.identity,
    generation: input.reflectionFallback.projectionGeneration,
    work: ADMITTED_WORK,
    budget: ADMITTED_BUDGET,
  });
}

/**
 * Joins the live owner projections at the renderer boundary. The only casts
 * here add the host identity to receipts that otherwise remain canonical RHI
 * or ReflectionProbe PODs; no producer fact is copied or renamed.
 */
export function projectSsrDependencies(input: {
  readonly requested: boolean;
  readonly identity: SsrAdmissionIdentity | undefined;
  readonly reflectionFallback: ReflectionFallbackReceipt | undefined;
  readonly format: RhiTextureFormatCapabilityReceipt | undefined;
  readonly temporal: { readonly successfulSubmit: true; readonly generation: number } | undefined;
  readonly previousGeneration?: number;
}): SsrDependenciesInspection {
  const identity = input.identity;
  const reflectionFallback =
    identity === undefined || input.reflectionFallback?.identity === undefined
      ? undefined
      : (input.reflectionFallback as SsrReflectionFallbackReceipt);
  const format =
    identity === undefined || input.format === undefined
      ? undefined
      : ({ ...input.format, identity } satisfies SsrFormatReceipt);
  const temporal =
    identity === undefined || input.temporal === undefined
      ? undefined
      : ({ identity, ...input.temporal } satisfies SsrTemporalReceipt);
  const admission =
    identity === undefined
      ? blocked(
          undefined,
          failure(
            input.requested ? 'ssr-receipt-identity-mismatch' : 'ssr-not-requested',
            'consumer',
            input.requested
              ? 'bind the exact source, tree, lock, and build identity before admission'
              : 'request SSR before evaluating M0 admission',
            input.requested ? { identityField: 'sourceHead' } : {},
          ),
        )
      : admitSsrM0({
          requested: input.requested,
          identity,
          ...(reflectionFallback === undefined ? {} : { reflectionFallback }),
          ...(format === undefined ? {} : { format }),
          ...(temporal === undefined ? {} : { temporal }),
          ...(input.previousGeneration === undefined
            ? {}
            : { previousGeneration: input.previousGeneration }),
        });
  return Object.freeze({
    status: admission.status,
    identity,
    requested: input.requested,
    reflectionFallback: input.reflectionFallback,
    format,
    temporal,
    admission,
    work: admission.work,
    budget: admission.budget,
    failure: admission.failure,
  });
}

export function zeroSsrAdmissionWork(): SsrAdmissionWork {
  return ZERO_WORK;
}

/**
 * Projects the admission decision into the existing temporal reset seam.
 * Admission never creates temporal history; only a changed committed
 * producer generation can request a reset through the coordinator.
 */
export function resolveSsrAdmissionGeneration(
  previousGeneration: number | undefined,
  nextGeneration: number | undefined,
): { readonly changed: boolean; readonly generation: number | undefined } {
  return {
    changed:
      previousGeneration !== undefined &&
      nextGeneration !== undefined &&
      previousGeneration !== nextGeneration,
    generation: nextGeneration,
  };
}
