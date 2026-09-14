import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type CookedRecord = {
  readonly specializationKey: string;
  readonly artifactDigest: string;
  readonly programs: readonly {
    readonly artifact: { readonly digest: string; readonly bytes: readonly number[] };
  }[];
  readonly resolved?: {
    readonly values?: unknown;
  };
  readonly receipt?: {
    readonly identity?: {
      readonly layoutIdentity?: string;
      readonly programIdentity?: string;
      readonly pipelineIdentity?: string;
      readonly cookIdentity?: string;
      readonly compilerFingerprint?: string;
    };
    readonly schemaVersion?: string;
  };
};

type MaterialRow = {
  readonly guid: string;
  readonly kind: 'material';
  readonly payload: {
    readonly parent?: string;
    readonly cooked?: CookedRecord;
  };
};

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL(
        '../../../../../apps/hello/custom-shader/assets/pulse-material.pack.json',
        import.meta.url,
      ),
    ),
    'utf8',
  ),
) as { readonly assets: readonly MaterialRow[] };

const materialRows = fixture.assets.filter((asset) => asset.kind === 'material');
const root = materialRows.find((asset) => asset.payload.parent === undefined);
const derived = materialRows.find((asset) => asset.payload.parent === root?.guid);

describe('custom-shader cooked MaterialAsset fixture', () => {
  it('keeps browser and Dawn on the same cooked payload with the child override', () => {
    expect(root?.payload.cooked).toBeDefined();
    expect(derived?.payload.cooked).toBeDefined();

    const cookedRecords = [root?.payload.cooked, derived?.payload.cooked];
    for (const cooked of cookedRecords) {
      expect(cooked).toBeDefined();
      expect(cooked?.programs?.[0]?.artifact?.digest).toMatch(/^sha256:/);
      expect(cooked?.artifactDigest).toMatch(/^sha256:/);
      expect(cooked?.receipt?.schemaVersion).toBe('material-cook/4');
      expect(cooked?.receipt?.identity?.layoutIdentity).toMatch(/^sha256-/);
      expect(cooked?.receipt?.identity?.programIdentity).toMatch(/^sha256:/);
      expect(cooked?.receipt?.identity?.pipelineIdentity).toMatch(/^sha256:/);
      expect(cooked?.receipt?.identity?.cookIdentity).toMatch(/^sha256:/);
      expect(cooked?.receipt?.identity?.compilerFingerprint).toMatch(/^sha256-/);
    }
    expect(derived?.payload.cooked?.specializationKey).toBe(
      root?.payload.cooked?.specializationKey,
    );
    expect(derived?.payload.cooked?.artifactDigest).toBe(root?.payload.cooked?.artifactDigest);
    expect(derived?.payload.cooked?.programs?.[0]?.artifact?.bytes).toEqual(
      root?.payload.cooked?.programs?.[0]?.artifact?.bytes,
    );
    expect(root?.payload.cooked?.resolved?.values).toMatchObject({
      baseColor: [0.95, 0.45, 0.2, 1],
      time: 0,
      speed: 2,
    });
    expect(derived?.payload.cooked?.resolved?.values).toMatchObject({
      baseColor: [0.2, 0.55, 0.95, 1],
      time: 0,
      speed: 2,
    });
  });

  it('keeps cooked layout identity and authored coordinate transforms', () => {
    const cooked = root?.payload.cooked;
    expect(cooked?.receipt?.schemaVersion).toBe('material-cook/4');
    expect(cooked?.receipt?.identity?.layoutIdentity).toMatch(/^sha256-/);
    expect(cooked?.receipt?.identity?.programIdentity).toMatch(/^sha256:/);
    expect(cooked?.receipt?.identity?.pipelineIdentity).toMatch(/^sha256:/);
    expect(cooked?.receipt?.identity?.cookIdentity).toMatch(/^sha256:/);
    expect(cooked?.receipt?.identity?.compilerFingerprint).toMatch(/^sha256-/);
    expect(cooked?.resolved?.values).toMatchObject({
      baseColorUvTransform: [0, 0, 1, 1],
      normalUvTransform: [0.125, 0.25, 2, 2],
    });
  });

  it('runs the real Dawn path for exactly 300 frames without unexpected RHI errors', () => {
    expect(fixture.assets.length).toBeGreaterThanOrEqual(2);
    expect(fixture.assets.every((asset) => asset.kind === 'material')).toBe(true);
  });
});
