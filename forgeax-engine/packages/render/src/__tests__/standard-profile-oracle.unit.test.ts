import { describe, expect, it } from 'vitest';
import {
  DEFAULT_STANDARD_PROFILE,
  STANDARD_LIGHT_COUNTS,
  STANDARD_PIPELINE_ID,
  type StandardProfile,
} from '../pipeline/standard-profile';

describe('Standard profile oracle', () => {
  it('requires the renderPath-only profile contract', () => {
    const profile: StandardProfile = DEFAULT_STANDARD_PROFILE;
    expect(profile.pipelineId).toBe('forgeax::standard');
    expect(profile.renderPath).toBe('forward');
    expect(profile).not.toHaveProperty('lighting');
    expect(profile).not.toHaveProperty('fallback');
  });

  it('keeps one identity across the supported light budgets', () => {
    expect(STANDARD_LIGHT_COUNTS).toEqual([1, 32, 256]);
    for (const lightCount of STANDARD_LIGHT_COUNTS) {
      const profile: StandardProfile = {
        ...DEFAULT_STANDARD_PROFILE,
        lightCount,
      };
      expect(profile.pipelineId).toBe(STANDARD_PIPELINE_ID);
      expect(profile.lightCount).toBe(lightCount);
    }
  });

  it('does not model a second lighting or fallback lane', () => {
    const profile = DEFAULT_STANDARD_PROFILE as unknown as Record<string, unknown>;
    expect(profile).not.toHaveProperty('lighting');
    expect(profile).not.toHaveProperty('fallback');
  });

  it('selects only the graph path; Cluster transport is capability-derived', () => {
    expect({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'forward' }).toMatchObject({
      pipelineId: STANDARD_PIPELINE_ID,
      renderPath: 'forward',
    });
    expect({ ...DEFAULT_STANDARD_PROFILE, renderPath: 'deferred' }).toMatchObject({
      pipelineId: STANDARD_PIPELINE_ID,
      renderPath: 'deferred',
    });
  });

  it('keeps the color-domain stage order stable for all profiles', () => {
    expect(DEFAULT_STANDARD_PROFILE.postStages).toEqual([
      'transparent-blend',
      'bloom',
      'output-transform',
      'fxaa',
      'post-effect',
      'present',
    ]);
  });
});
