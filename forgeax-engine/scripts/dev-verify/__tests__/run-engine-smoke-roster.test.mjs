import { describe, expect, it } from 'vitest';
import { discoverSmokeApps } from '../run-engine-smoke-roster.mjs';

describe('dynamic engine smoke roster', () => {
  it('discovers hello and learn-render apps from smoke metadata', () => {
    const roster = discoverSmokeApps(process.cwd());
    expect(roster.some((app) => app.name === '@forgeax/hello-deep-agent-feedback')).toBe(true);
    expect(roster.every((app) => app.invocation.startsWith('pnpm --filter '))).toBe(true);
  });
});
