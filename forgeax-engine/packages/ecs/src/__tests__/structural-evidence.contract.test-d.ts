import type { StructuralEvidence, StructuralEvidenceKind } from '../storage/structural-evidence';

const kind: StructuralEvidenceKind = 'component-added';
const evidence: StructuralEvidence = { sequence: 1, kind, entity: 0 as never, componentId: 4 };
// @ts-expect-error evidence sequence is producer-owned.
evidence.sequence = 2;
