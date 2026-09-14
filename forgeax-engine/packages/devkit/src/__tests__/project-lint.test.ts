import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { projectLintCommand } from '../commands.js';
import type { ProjectLintResult } from '../project/lint.js';

async function project(
  forge: Record<string, unknown>,
  modules: Record<string, string>,
  packageJson: Record<string, unknown> = { name: 'lint-fixture' },
): Promise<string> {
  const root = await mkdtemp(resolve(tmpdir(), 'forgeax-project-lint-'));
  await writeFile(resolve(root, 'forge.json'), JSON.stringify(forge));
  await writeFile(resolve(root, 'package.json'), JSON.stringify(packageJson));
  for (const [relativePath, source] of Object.entries(modules)) {
    const path = resolve(root, relativePath);
    await mkdir(resolve(path, '..'), { recursive: true });
    await writeFile(path, source);
  }
  return root;
}

const validForge = {
  id: 'lint-fixture',
  name: 'Lint fixture',
  schemaVersion: '2.0.0',
  plugins: [{ id: 'gameplay', name: './assets/plugin.ts', realm: 'engine' }],
};

const validRootPlugin = `
import { childPlugin } from './child.plugin.ts';
import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
export const projectPlugin = definePluginGroup({
  name: 'project',
  children: () => [usePlugin(childPlugin)],
});
`;

describe('projectLintCommand', () => {
  it('accepts the shipped game-3d template provider graph', async () => {
    const result = await projectLintCommand({
      root: resolve(import.meta.dirname, '../../../../templates/game-3d'),
      json: true,
    });

    expect(result).toEqual(
      expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ diagnostics: [] }),
      }),
    );
  });

  it('accepts one explicit Entry to Group ownership path without executing modules', async () => {
    const root = await project(validForge, {
      'assets/plugin.ts': validRootPlugin,
      'assets/child.plugin.ts': `export const childPlugin = { name: 'child', apply() {} };`,
    });

    const result = await projectLintCommand({ root, json: true });

    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        root,
        diagnostics: [],
        ownership: expect.arrayContaining([
          expect.objectContaining({
            module: 'assets/plugin.ts',
            ownerPath: 'forge.json#plugins[gameplay]',
          }),
          expect.objectContaining({
            module: 'assets/child.plugin.ts',
            ownerPath:
              'forge.json#plugins[gameplay] > usePlugin(childPlugin) > assets/child.plugin.ts',
          }),
        ]),
      }),
    });
  });

  it('reports orphan plugin files and does not auto-activate them', async () => {
    const root = await project(validForge, {
      'assets/plugin.ts': validRootPlugin,
      'assets/child.plugin.ts': `export const childPlugin = { name: 'child', apply() {} };`,
      'assets/orphan.plugin.ts': `throw new Error('must not execute');`,
    });

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('project-lint-failed');
      expect(result.error.expected).toContain('ownership');
      expect(result.error.hint).toContain('owning Plugin');
      expect(result.error.detail).toEqual(
        expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              ruleId: 'project-ownership-orphan',
              ownerPath: 'assets/orphan.plugin.ts',
              detail: expect.objectContaining({ module: 'assets/orphan.plugin.ts' }),
            }),
          ]),
        }),
      );
    }
  });

  it('reports manifest and Group multi-owner overlap with stable paths', async () => {
    const root = await project(
      {
        ...validForge,
        plugins: [
          ...validForge.plugins,
          { id: 'duplicate-gameplay', name: './assets/plugin.ts', realm: 'engine' },
        ],
      },
      { 'assets/plugin.ts': validRootPlugin },
    );

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toEqual(
        expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              ruleId: 'project-ownership-multi-owner',
              ownerPath: 'forge.json#plugins[duplicate-gameplay]',
              expected: expect.stringContaining('one ownership path'),
              hint: expect.stringContaining('remove the duplicate Entry'),
              detail: expect.objectContaining({ module: 'assets/plugin.ts' }),
            }),
          ]),
        }),
      );
    }
  });

  it('reports a manifest Entry that is also reached by a Group edge', async () => {
    const root = await project(
      {
        ...validForge,
        plugins: [
          ...validForge.plugins,
          { id: 'child-entry', name: './assets/child.plugin.ts', realm: 'engine' },
        ],
      },
      {
        'assets/plugin.ts': validRootPlugin,
        'assets/child.plugin.ts': `export const childPlugin = { name: 'child', apply() {} };`,
      },
    );

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'project-ownership-multi-owner',
            detail: expect.objectContaining({
              module: 'assets/child.plugin.ts',
              owners: expect.arrayContaining([
                'forge.json#plugins[child-entry]',
                expect.stringContaining('usePlugin(childPlugin)'),
              ]),
            }),
          }),
        ]),
      );
    }
  });

  it('reports cross-realm declarations before module execution', async () => {
    const root = await project(
      {
        ...validForge,
        plugins: [{ id: 'host-tools', name: './assets/host.plugin.ts', realm: 'host' }],
      },
      {
        'assets/host.plugin.ts': `throw new Error('must not execute');`,
      },
    );

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const diagnostics = result.error.detail.diagnostics;
      expect(diagnostics).toEqual(
        expect.arrayContaining([expect.objectContaining({ ruleId: 'project-realm-invalid' })]),
      );
    }
  });

  it('reports missing providers before module execution', async () => {
    const root = await project(
      {
        ...validForge,
        plugins: [
          {
            id: 'consumer',
            name: './assets/consumer.plugin.ts',
            inject: ['missing'],
            realm: 'engine',
          },
        ],
      },
      { 'assets/consumer.plugin.ts': `throw new Error('must not execute');` },
    );

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toEqual(
        expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              ruleId: 'project-provider-missing',
              detail: expect.objectContaining({ service: 'missing' }),
            }),
          ]),
        }),
      );
    }
  });

  it('rejects legacy package asset roots with a closed diagnostic', async () => {
    const root = await project(
      validForge,
      { 'assets/plugin.ts': validRootPlugin },
      { name: 'lint-fixture', forgeax: { assets: { roots: ['src'], importers: [] } } },
    );

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail).toEqual(
        expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({
              ruleId: 'project-legacy-field',
              ownerPath: 'package.json#forgeax.assets',
              detail: expect.objectContaining({ field: 'forgeax.assets' }),
            }),
          ]),
        }),
      );
    }
  });

  it('does not treat import type as executable ownership', async () => {
    const root = await project(validForge, {
      'assets/plugin.ts': `import type { childPlugin } from './orphan.plugin.ts';
export const projectPlugin = { name: 'project' };`,
      'assets/orphan.plugin.ts': `throw new Error('must not execute');`,
    });

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'project-ownership-orphan',
            ownerPath: 'assets/orphan.plugin.ts',
          }),
        ]),
      );
    }
  });

  it('retains both owner paths for a shared usePlugin leaf', async () => {
    const root = await project(
      {
        ...validForge,
        plugins: [
          { id: 'first', name: './assets/first.plugin.ts', realm: 'engine' },
          { id: 'second', name: './assets/second.plugin.ts', realm: 'engine' },
        ],
      },
      {
        'assets/first.plugin.ts': `import { shared } from './shared.ts';
import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
export const first = definePluginGroup({ name: 'first', children: () => [usePlugin(shared)] });`,
        'assets/second.plugin.ts': `import { shared } from './shared.ts';
import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
export const second = definePluginGroup({ name: 'second', children: () => [usePlugin(shared)] });`,
        'assets/shared.ts': `export const shared = { name: 'shared', apply() {} };`,
      },
    );

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'project-ownership-multi-owner',
            detail: expect.objectContaining({
              module: 'assets/shared.ts',
              owners: expect.arrayContaining([
                expect.stringContaining('forge.json#plugins[first]'),
                expect.stringContaining('forge.json#plugins[second]'),
              ]),
            }),
          }),
        ]),
      );
    }
  });

  it('does not infer a missing provider from an unrelated external Entry', async () => {
    const root = await project(
      {
        ...validForge,
        plugins: [
          { id: 'external', name: '@forgeax/unknown-provider', realm: 'engine' },
          {
            id: 'consumer',
            name: './assets/consumer.plugin.ts',
            inject: ['missing'],
            realm: 'engine',
          },
        ],
      },
      { 'assets/consumer.plugin.ts': `export const consumer = { name: 'consumer' };` },
    );

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'project-provider-missing',
            detail: expect.objectContaining({ service: 'missing' }),
          }),
        ]),
      );
    }
  });

  it('classifies a missing package manifest as a reader diagnostic', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-project-lint-reader-'));
    await writeFile(resolve(root, 'forge.json'), JSON.stringify(validForge));

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'project-reader-error',
            ownerPath: 'package.json',
            detail: expect.objectContaining({ code: 'project-manifest-unreadable' }),
          }),
        ]),
      );
    }
  });

  it('classifies a missing forge manifest as a forge reader diagnostic', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'forgeax-project-lint-forge-reader-'));
    await writeFile(resolve(root, 'package.json'), JSON.stringify({ name: 'lint-fixture' }));

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'project-reader-error',
            ownerPath: 'forge.json',
            detail: expect.objectContaining({ code: 'project-manifest-unreadable' }),
          }),
        ]),
      );
    }
  });

  it('rejects a nested Group that is also manifest-owned in the same scope', async () => {
    const root = await project(
      {
        ...validForge,
        plugins: [
          {
            id: 'root-group',
            name: './assets/root.plugin.ts',
            group: true,
            config: [
              {
                id: 'nested-group',
                name: './assets/nested.plugin.ts',
                group: true,
                config: [{ id: 'leaf', name: './assets/leaf.plugin.ts', realm: 'engine' }],
              },
            ],
          },
        ],
      },
      {
        'assets/root.plugin.ts': `import { nested } from './nested.plugin.ts';
import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
export const root = definePluginGroup({ name: 'root', children: () => [usePlugin(nested)] });`,
        'assets/nested.plugin.ts': `import { leaf } from './leaf.plugin.ts';
import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
export const nested = definePluginGroup({ name: 'nested', children: () => [usePlugin(leaf)] });`,
        'assets/leaf.plugin.ts': `export const leaf = { name: 'leaf', apply() {} };`,
      },
    );

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'project-ownership-multi-owner',
            detail: expect.objectContaining({ module: 'assets/nested.plugin.ts' }),
          }),
          expect.objectContaining({
            ruleId: 'project-ownership-multi-owner',
            detail: expect.objectContaining({ module: 'assets/leaf.plugin.ts' }),
          }),
        ]),
      );
    }
  });

  it('does not own a Group reached only by a side-effect import', async () => {
    const root = await project(validForge, {
      'assets/plugin.ts': `import './side-effect-group.plugin.ts';
export const root = { name: 'root' };`,
      'assets/side-effect-group.plugin.ts': `import { leaf } from './leaf.plugin.ts';
import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
export const group = definePluginGroup({ name: 'side-effect', children: () => [usePlugin(leaf)] });`,
      'assets/leaf.plugin.ts': `export const leaf = { name: 'leaf', apply() {} };`,
    });

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      const orphanModules = result.error.detail.diagnostics
        .filter((diagnostic) => diagnostic.ruleId === 'project-ownership-orphan')
        .map((diagnostic) => diagnostic.detail.module);
      expect(orphanModules).toEqual(
        expect.arrayContaining(['assets/side-effect-group.plugin.ts', 'assets/leaf.plugin.ts']),
      );
    }
  });

  it('projects code-composed nested Groups once from a manifest-only root', async () => {
    const root = await project(validForge, {
      'assets/plugin.ts': `import { nested } from './nested.plugin.ts';
import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
export const root = definePluginGroup({ name: 'root', children: () => [usePlugin(nested)] });`,
      'assets/nested.plugin.ts': `import { leaf } from './leaf.plugin.ts';
import { definePluginGroup, usePlugin } from '@forgeax/engine/plugin';
export const nested = definePluginGroup({ name: 'nested', children: () => [usePlugin(leaf)] });`,
      'assets/leaf.plugin.ts': `export const leaf = { name: 'leaf', apply() {} };`,
    });

    const result = await projectLintCommand({ root, json: true });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.ownership).toEqual([
        expect.objectContaining({
          module: 'assets/plugin.ts',
          ownerPath: 'forge.json#plugins[gameplay]',
          source: 'manifest',
        }),
        expect.objectContaining({
          module: 'assets/nested.plugin.ts',
          ownerPath: expect.stringContaining('usePlugin(nested)'),
          source: 'plugin-edge',
        }),
        expect.objectContaining({
          module: 'assets/leaf.plugin.ts',
          ownerPath: expect.stringContaining('usePlugin(leaf)'),
          source: 'plugin-edge',
        }),
      ]);
    }
  });

  it('terminates a static import cycle with a stable cycle diagnostic', async () => {
    const root = await project(
      {
        ...validForge,
        plugins: [{ id: 'cycle', name: './assets/first.plugin.ts', realm: 'engine' }],
      },
      {
        'assets/first.plugin.ts': `import { second } from './second.plugin.ts';
export const first = second;`,
        'assets/second.plugin.ts': `import { first } from './first.plugin.ts';
export const second = first;`,
      },
    );

    const result = await Promise.race([
      projectLintCommand({ root, json: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('project lint cycle did not terminate')), 1000),
      ),
    ]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.detail.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ruleId: 'project-ownership-cycle',
            ownerPath: expect.stringContaining('forge.json#plugins[cycle]'),
            detail: expect.objectContaining({
              module: expect.stringMatching(/assets\/(first|second)\.plugin\.ts/),
            }),
          }),
        ]),
      );
    }
  });

  it('exposes a closed project lint result to direct TypeScript callers', async () => {
    expectTypeOf<
      Awaited<ReturnType<typeof projectLintCommand>>
    >().toEqualTypeOf<ProjectLintResult>();
  });
});
