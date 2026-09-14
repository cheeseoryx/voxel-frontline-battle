import { describe, expect, it } from 'vitest';
import { resolveShadowMapSize } from '../../../render/src/record/frame-targets';

describe('frame targets shadow removal', () => {
  it('fits a cascaded shadow atlas within the device texture limit', () => {
    const internals = {
      device: { limits: { maxTextureDimension2D: 2048 } },
    };
    const lights = { shadowMapSize: 2048, cascadeCount: 4 };

    expect(resolveShadowMapSize(internals as never, lights as never)).toBe(1024);
    expect(resolveShadowMapSize(internals as never, { ...lights, cascadeCount: 1 } as never)).toBe(
      2048,
    );
  });

  it('reserves the WebGL2 depth-texture ceiling below the generic texture limit', () => {
    const internals = {
      device: {
        caps: { backendKind: 'wgpu-webgl2' },
        limits: { maxTextureDimension2D: 2048 },
      },
    };
    const lights = { shadowMapSize: 2048, cascadeCount: 1 };

    expect(resolveShadowMapSize(internals as never, lights as never)).toBe(1024);
  });

  it('does not resolve a Directional atlas for the disabled topology sentinel', () => {
    const internals = {
      device: { limits: { maxTextureDimension2D: 2048 } },
    };
    const lights = {
      directional: 'disabled',
      shadowMapSize: 2048,
      cascadeCount: undefined,
    };

    expect(resolveShadowMapSize(internals as never, lights as never)).toBeUndefined();
  });
});
