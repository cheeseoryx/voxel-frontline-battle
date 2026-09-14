import { describe, expect, it } from 'vitest';
import { encodeEntity } from '../entity-handle';
import { StructuralEvidenceRing } from '../storage/structural-evidence';

describe('typed structural evidence ring', () => {
  it('records lifecycle, component membership, packed identity, and sequence facts', () => {
    const ring = new StructuralEvidenceRing(8);
    const entity = encodeEntity(4, 2);
    const cursor = ring.cursor;
    ring.append({ kind: 'spawn', entity });
    ring.append({ kind: 'component-added', entity, componentId: 7 });
    ring.append({ kind: 'component-removed', entity, componentId: 7 });
    ring.append({ kind: 'despawn', entity });
    const read = ring.readAfter(cursor);
    expect(read.status).toBe('ok');
    if (read.status !== 'ok') return;
    expect(
      read.events.map(({ kind, entity: packed, sequence }) => ({ kind, packed, sequence })),
    ).toEqual([
      { kind: 'spawn', packed: entity, sequence: 1 },
      { kind: 'component-added', packed: entity, sequence: 2 },
      { kind: 'component-removed', packed: entity, sequence: 3 },
      { kind: 'despawn', packed: entity, sequence: 4 },
    ]);
  });

  it('fails closed on overflow and exposes the cursor for consumer reconciliation', () => {
    const ring = new StructuralEvidenceRing(2);
    const cursor = ring.cursor;
    const entity = encodeEntity(1, 4);
    const reused = encodeEntity(1, 5);
    ring.append({ kind: 'spawn', entity });
    ring.append({ kind: 'despawn', entity });
    ring.append({ kind: 'spawn', entity: reused });
    expect(ring.readAfter(cursor)).toMatchObject({
      status: 'overflow',
      cursor: 3,
      oldestAvailable: 2,
    });
    expect(ring.cursor).toBe(3);
  });

  it('rejects cursors outside the producer-owned sequence range', () => {
    const ring = new StructuralEvidenceRing(4);
    const entity = encodeEntity(3, 1);
    ring.append({ kind: 'spawn', entity });
    expect(() => ring.readAfter(2)).toThrow(RangeError);
  });
});
