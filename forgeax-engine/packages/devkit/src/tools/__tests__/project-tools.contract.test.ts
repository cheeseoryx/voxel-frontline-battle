import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverProjectTools, runProjectTool } from '../project-tools.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('pure project command contracts', () => {
  it('discovers without loading the delayed executor', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-command-contract-'));
    roots.push(root);
    await writeFile(
      join(root, 'forge.json'),
      JSON.stringify({
        id: 'contract-fixture',
        name: 'Contract fixture',
        schemaVersion: '2.0.0',
        plugins: [
          {
            id: 'commands',
            name: './commands.contract.ts',
            commandContract: './commands.contract.ts',
            realm: 'build',
          },
        ],
      }),
    );
    let executorLoaded = false;
    const loader = {
      async load(name: string): Promise<unknown> {
        if (name === './commands.contract.ts') {
          return {
            default: {
              schemaVersion: '1.0.0',
              commands: [
                {
                  id: 'fixture.echo',
                  path: ['fixture', 'echo'],
                  title: 'Echo',
                  summary: 'Echoes input',
                  realm: 'build',
                  argsSchema:
                    '{"type":"object","properties":{"value":{"type":"string"}},"required":["value"],"additionalProperties":false}',
                  executor: './commands.executor.ts',
                },
              ],
            },
          };
        }
        if (name.endsWith('commands.executor.ts')) {
          executorLoaded = true;
          return { default: async (args: { readonly value: string }) => ({ echoed: args.value }) };
        }
        throw new Error(`unexpected module ${name}`);
      },
      async close(): Promise<void> {},
    };
    const bindings = await discoverProjectTools(root, { moduleLoader: loader });
    expect(bindings).toHaveLength(1);
    expect(executorLoaded).toBe(false);
    const binding = bindings[0];
    expect(binding?.contribution.descriptor.path).toEqual(['fixture', 'echo']);
    if (binding === undefined) throw new Error('fixture binding is missing');
    const terminal = await runProjectTool(binding, { value: 'ok' }, {});
    expect(terminal).toMatchObject({ outcome: 'succeeded', result: { echoed: 'ok' } });
    expect(executorLoaded).toBe(true);
  });

  it('does not hide malformed forge.json from built-in discovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-command-invalid-'));
    roots.push(root);
    await writeFile(join(root, 'forge.json'), '{"schemaVersion":"broken"}');
    await expect(
      discoverProjectTools(root, {
        moduleLoader: { load: async () => ({}), close: async () => {} },
      }),
    ).rejects.toThrow('Invalid forge.json');
  });
});
