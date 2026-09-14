import { describe, expect, it } from 'vitest';
import { getOrCreateFromChain } from '../mesh-ssbo';

describe('mesh bind-group cache chains', () => {
  it('keeps variable-depth material resource chains isolated', () => {
    const root = new WeakMap<object, unknown>();
    const shared = { shared: true };
    const coatSampler = { coatSampler: true };
    const coatTexture = { coatTexture: true };
    const counts = { createBindGroup: 0, keys: [] as string[] };
    const long = getOrCreateFromChain(
      root,
      [shared, coatSampler, coatTexture],
      'material-shared',
      () => ({ id: 'long' }) as never,
      counts,
    );
    const short = getOrCreateFromChain(
      root,
      [shared, coatSampler],
      'material-shared',
      () => ({ id: 'short' }) as never,
      counts,
    );

    expect(
      getOrCreateFromChain(
        root,
        [shared, coatSampler],
        'material-shared',
        () => ({ id: 'unexpected' }) as never,
        counts,
      ),
    ).toBe(short);
    expect(long).not.toBe(short);
    expect(counts.createBindGroup).toBe(2);
  });
});
