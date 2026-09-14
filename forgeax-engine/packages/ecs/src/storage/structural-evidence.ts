import type { EntityHandle } from '../entity-handle';

export type StructuralEvidenceKind = 'spawn' | 'despawn' | 'component-added' | 'component-removed';

export interface StructuralEvidenceInput {
  readonly kind: StructuralEvidenceKind;
  readonly entity: EntityHandle;
  readonly componentId?: number;
}

export interface StructuralEvidence extends StructuralEvidenceInput {
  readonly sequence: number;
}

export type StructuralEvidenceRead =
  | {
      readonly status: 'ok';
      readonly cursor: number;
      readonly events: readonly StructuralEvidence[];
    }
  | { readonly status: 'overflow'; readonly cursor: number; readonly oldestAvailable: number };

/** Bounded producer-owned structural evidence; consumers never infer facts by scanning. */
export class StructuralEvidenceRing {
  private readonly events: Array<StructuralEvidence | undefined>;
  private nextSequence = 1;

  constructor(readonly capacity = 1024) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new RangeError('StructuralEvidenceRing capacity must be a positive safe integer');
    }
    this.events = new Array<StructuralEvidence | undefined>(capacity);
  }

  get cursor(): number {
    return this.nextSequence - 1;
  }

  append(input: StructuralEvidenceInput): number {
    const sequence = this.nextSequence;
    this.nextSequence += 1;
    this.events[(sequence - 1) % this.capacity] = { ...input, sequence };
    return sequence;
  }

  readAfter(cursor: number): StructuralEvidenceRead {
    const latest = this.cursor;
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > latest) {
      throw new RangeError(`StructuralEvidenceRing cursor ${cursor} is outside 0..${latest}`);
    }
    const oldestAvailable = Math.max(1, latest - this.capacity + 1);
    if (cursor < oldestAvailable - 1)
      return { status: 'overflow', cursor: latest, oldestAvailable };
    const events: StructuralEvidence[] = [];
    for (let sequence = cursor + 1; sequence <= latest; sequence += 1) {
      const event = this.events[(sequence - 1) % this.capacity];
      if (event === undefined || event.sequence !== sequence) {
        return { status: 'overflow', cursor: latest, oldestAvailable };
      }
      events.push(event);
    }
    return { status: 'ok', cursor: latest, events };
  }
}
