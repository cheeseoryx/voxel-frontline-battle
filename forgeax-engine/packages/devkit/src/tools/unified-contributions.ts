import {
  defineCommand,
  type JsonValue,
  type ToolContribution,
  type ToolDomainFailure,
  type ToolJsonSchema,
  type ToolRealm,
  toolJsonSchema,
} from '@forgeax/engine-tool-runtime';

type CommandValue =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly expected?: string;
        readonly hint?: string;
        readonly detail?: unknown;
      };
    };

type CommandError = Extract<CommandValue, { readonly ok: false }>['error'];

type LiveOperation =
  | 'status'
  | 'reload'
  | 'stop'
  | 'capture'
  | 'eval'
  | 'camera/get'
  | 'camera/set'
  | 'focus';

const string = { type: 'string' } satisfies ToolJsonSchema;
const captureBackend = {
  type: 'string',
  enum: ['auto', 'hardware', 'software'],
} satisfies ToolJsonSchema;
const executionTier = {
  type: 'string',
  enum: ['main-serial', 'engine-worker'],
} satisfies ToolJsonSchema;
const boolean = { type: 'boolean' } satisfies ToolJsonSchema;
const number = { type: 'number' } satisfies ToolJsonSchema;
const integer = { type: 'integer' } satisfies ToolJsonSchema;
const port = { type: 'integer', minimum: 0, maximum: 65_535 } satisfies ToolJsonSchema;
const liveIdentity = {
  instance: string,
  instanceId: string,
  loadId: string,
  worldIdentity: string,
};

const schema = (
  properties: Readonly<Record<string, ToolJsonSchema>>,
  required: readonly string[] = [],
): ToolJsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const root = { root: string };
const commandSchemas: Readonly<Record<string, ToolJsonSchema>> = {
  'project new': schema({
    ...root,
    template: string,
    id: string,
    name: string,
    packageName: string,
    dryRun: boolean,
  }),
  'project init': schema({ ...root, install: boolean, dryRun: boolean }),
  'project check': schema({ ...root, json: boolean }),
  'project test': schema({ ...root, json: boolean }),
  'project package': schema({ ...root, output: string, format: string, json: boolean }),
  'project preview': schema({ ...root, port, json: boolean }),
  'project capture': schema({
    ...root,
    output: string,
    backend: string,
    software: boolean,
    headless: boolean,
    port,
    width: integer,
    height: integer,
    waitMs: integer,
    requireUi: boolean,
    deterministic: boolean,
  }),
  'project engine status': schema({ ...root, json: boolean }),
  'project engine use-local': schema({ ...root, path: string, json: boolean }),
  'project engine unlink': schema({ ...root, json: boolean }),
  'project engine check': schema({ ...root, json: boolean }),
  'project skill install': schema({ ...root, json: boolean }),
  'project skill verify': schema({ ...root, json: boolean }),
  'project plugin install': schema(
    { ...root, id: string, module: string, realm: string, dependency: string },
    ['id', 'module'],
  ),
  'project plugin list': schema({ ...root }),
  'project plugin inspect': schema({ ...root, id: string }),
  'project plugin configure': schema({ ...root, id: string, config: { type: 'object' } }, [
    'id',
    'config',
  ]),
  'project plugin disable': schema({ ...root, id: string }, ['id']),
  'project plugin enable': schema({ ...root, id: string }, ['id']),
  'project plugin uninstall': schema({ ...root, id: string, dependency: string }, ['id']),
  'asset import': schema({ ...root, path: string, dryRun: boolean, json: boolean }, ['path']),
  'asset list': schema({ ...root, json: boolean }),
  'asset inspect': schema({ ...root, subject: string, json: boolean }, ['subject']),
  'asset resolve': schema({ ...root, subject: string, json: boolean }, ['subject']),
  'asset verify': schema({ ...root, subject: string, json: boolean }),
  'asset shader check': schema({ ...root, path: string, json: boolean }),
  'asset preview': schema({ ...root, kind: string, guid: string, json: boolean }, ['kind', 'guid']),
  'asset atlas': schema(
    {
      ...root,
      input: string,
      name: string,
      output: string,
      maxAtlasSize: integer,
      json: boolean,
    },
    ['input', 'name'],
  ),
  'sdk install': schema({ ...root, version: string }),
  'debug preview analyze': schema({ ...root, artifact: string, json: boolean }),
  'debug rhi capture': schema({ ...root, output: string, json: boolean }),
  'debug rhi summary': schema({ ...root, artifact: string, digest: string, json: boolean }),
  'debug rhi inspect': schema({
    ...root,
    artifact: string,
    digest: string,
    workId: integer,
    json: boolean,
  }),
  'debug profile capture': schema({ ...root, output: string, json: boolean }),
  'debug profile summary': schema({ ...root, artifact: string, json: boolean }),
  'debug profile frame': schema({ ...root, artifact: string, frameId: integer, json: boolean }),
  'debug profile phase': schema({
    ...root,
    artifact: string,
    source: string,
    phase: string,
    json: boolean,
  }),
  'debug profile compare': schema({ ...root, leftFile: string, rightFile: string, json: boolean }, [
    'leftFile',
    'rightFile',
  ]),
  'dev start': schema({ ...root, headless: boolean, backend: captureBackend, tier: executionTier }),
  'dev status': schema({ ...root }),
  'dev reload': schema({ ...root }),
  'dev stop': schema({ ...root }),
  'dev eval': schema({ ...root, ...liveIdentity, code: string, timeoutMs: integer }, ['code']),
  'dev camera get': schema({ ...root, ...liveIdentity }),
  'dev camera set': schema(
    {
      ...root,
      ...liveIdentity,
      entity: integer,
      position: { type: 'array', items: number, minItems: 3 },
      target: { type: 'array', items: number, minItems: 3 },
      up: { type: 'array', items: number, minItems: 3 },
    },
    ['entity'],
  ),
  'dev focus': schema(
    {
      ...root,
      ...liveIdentity,
      entity: integer,
      distance: number,
      target: { type: 'array', items: number, minItems: 3 },
      position: { type: 'array', items: number, minItems: 3 },
      up: { type: 'array', items: number, minItems: 3 },
    },
    ['entity'],
  ),
  'dev capture': schema({ ...root, ...liveIdentity, output: string, checkpoint: string }),
};

function commandSchema(path: readonly string[]): ToolJsonSchema {
  return commandSchemas[path.join(' ')] ?? schema({ ...root });
}

function result(
  value: CommandValue,
): unknown | { readonly ok: false; readonly error: ToolDomainFailure } {
  if (value.ok) return value.value;
  return {
    ok: false,
    error: {
      code: value.error.code,
      expected: value.error.expected,
      hint: value.error.hint,
      detail: value.error.detail as JsonValue,
    },
  };
}

export function command<TArgs extends Record<string, unknown>>(
  id: string,
  path: readonly string[],
  title: string,
  summary: string,
  execute: (args: TArgs) => Promise<CommandValue>,
  realm: ToolRealm = 'build',
  options: {
    readonly schema?: ToolJsonSchema;
    readonly capabilities?: readonly string[];
    readonly errors?: readonly string[];
    readonly example?: JsonValue;
  } = {},
): ToolContribution<TArgs, unknown> {
  const argsSchema = options.schema ?? commandSchema(path);
  return defineCommand(
    {
      id,
      path,
      title,
      summary,
      realm,
      argsSchema: toolJsonSchema<TArgs>(argsSchema),
      resultSchema: toolJsonSchema({ type: 'object' }),
      evidence: [],
      capabilities: options.capabilities ?? [],
      errors: options.errors ?? ['tool-invalid-args', 'tool-capability-unavailable'],
      ...(options.example === undefined ? {} : { example: options.example }),
      inputSchema: argsSchema as unknown as JsonValue,
    },
    async (args) => result(await execute(args)),
  );
}

function rootArgs<T extends Record<string, unknown>>(root: string, args: T): T & { root: string } {
  return { ...args, root: typeof args.root === 'string' ? args.root : root };
}

export function createUnifiedCommandContributions(
  projectRoot = process.cwd(),
): readonly ToolContribution[] {
  const project = (
    id: string,
    path: readonly string[],
    title: string,
    summary: string,
    method: string,
  ) =>
    command(id, path, title, summary, async (args) => {
      const commands = (await import('../commands.js')) as unknown as Record<
        string,
        (value: unknown) => Promise<CommandValue>
      >;
      const handler = commands[method];
      if (handler === undefined) {
        return {
          ok: false,
          error: {
            code: 'command-unavailable',
            expected: method,
            hint: 'Install the matching DevKit command owner.',
          },
        };
      }
      return handler(rootArgs(projectRoot, args));
    });

  const live = (
    id: string,
    path: readonly string[],
    title: string,
    summary: string,
    operation: LiveOperation,
  ) =>
    command(
      id,
      path,
      title,
      summary,
      async (args) => {
        const liveDev = await import('../live-dev.js');
        if (operation === 'status')
          return { ok: true, value: await liveDev.liveDevStatus(projectRoot) };
        return { ok: true, value: await liveDev.liveDevControl(projectRoot, operation, args) };
      },
      'host',
      {
        capabilities: ['live-instance', ...(operation === 'status' ? [] : ['world-observation'])],
        errors: [
          'live-not-ready',
          'live-instance-required',
          'live-instance-stale',
          'live-world-stale',
          'live-instance-changed',
        ],
        ...(operation === 'status'
          ? {}
          : { example: { instanceId: '<from dev status>', worldIdentity: '<from dev status>' } }),
      },
    );
  const start = command(
    'dev.start',
    ['dev', 'start'],
    'Start live project',
    'Starts one persistent DevKit owner and its controlled browser Page.',
    async (args) => ({
      ok: true,
      value: await (await import('../live-dev.js')).startLiveDev(projectRoot, {
        ...(typeof args.headless === 'boolean' ? { headless: args.headless } : {}),
        ...(args.backend === 'auto' || args.backend === 'hardware' || args.backend === 'software'
          ? { backend: args.backend }
          : {}),
        ...(args.tier === 'main-serial' || args.tier === 'engine-worker'
          ? { tier: args.tier }
          : {}),
      }),
    }),
    'host',
  );
  const offlinePreviewAnalysis = command(
    'preview.offline-analysis',
    ['debug', 'preview', 'analyze'],
    'Analyze preview artifacts',
    'Validates artifact identity and required evidence without starting a browser.',
    async (args) => {
      const { analyzePreviewArtifacts } = await import('./offline-analysis.js');
      const analyzed = analyzePreviewArtifacts(args as never);
      return analyzed.ok
        ? { ok: true, value: analyzed.value }
        : { ok: false, error: analyzed.error };
    },
  );
  const assetPreview = command(
    'asset.preview',
    ['asset', 'preview'],
    'Preview an asset',
    'Produces canonical GUID-based resource evidence through the owning preview plugin.',
    async (args) => {
      const kind = typeof args.kind === 'string' ? args.kind : 'mesh';
      const nativePreview = await import('./native-preview.js');
      const catalog = await import('./preview-catalog.js');
      const contribution = catalog.nativePreviewTools.find(
        (candidate) => candidate.descriptor.id === `${kind}.preview`,
      );
      if (contribution === undefined) {
        return {
          ok: false,
          error: {
            code: 'asset-preview-kind-unavailable',
            expected: 'kind to select material, mesh, texture, or vfx',
            hint: 'Pass { kind, guid } and retry with one of the admitted preview owners.',
            detail: { kind },
          },
        };
      }
      const { kind: _kind, ...request } = args;
      const terminal = await nativePreview.runNativePreviewTool(
        contribution,
        request,
        {},
        projectRoot,
      );
      return terminal.outcome === 'succeeded'
        ? { ok: true, value: terminal.result }
        : { ok: false, error: terminal.failure };
    },
    'host',
  );
  const assetAtlas = command(
    'asset.atlas',
    ['asset', 'atlas'],
    'Build asset atlas',
    'Builds a deterministic PNG atlas and sidecar through the Pack producer.',
    async (args) => ({
      ...(await (async () => {
        const input = typeof args.input === 'string' ? args.input : undefined;
        const name = typeof args.name === 'string' ? args.name : undefined;
        if (input === undefined || name === undefined) {
          return {
            ok: false as const,
            error: {
              code: 'tool-invalid-args',
              expected: '--input <glob> and --name <prefix>',
              hint: 'Pass the image glob and output prefix, then retry.',
              detail: {},
            },
          };
        }
        const { runAtlas } = await import('@forgeax/engine-pack/cli-asset');
        const stdout: string[] = [];
        const stderr: string[] = [];
        const rest = ['--input', input, '--name', name];
        if (typeof args.output === 'string') rest.push('--output', args.output);
        if (typeof args.maxAtlasSize === 'number')
          rest.push('--max-atlas-size', String(args.maxAtlasSize));
        const exitCode = await runAtlas(rest, {
          cwd: projectRoot,
          stdoutWrite: (line: string) => stdout.push(line),
          stderrWrite: (line: string) => stderr.push(line),
        });
        if (exitCode !== 0) {
          let error: CommandError = {
            code: 'asset-atlas-failed',
            expected: 'the Pack atlas producer to complete',
            hint: stderr.at(-1) ?? 'Inspect the atlas inputs and retry.',
            detail: { exitCode },
          };
          const raw = stderr.at(-1);
          if (raw !== undefined) {
            try {
              const parsed = JSON.parse(raw) as Partial<CommandError>;
              if (typeof parsed.code === 'string') error = { ...error, ...parsed };
            } catch {
              // Keep the producer failure in the structured fallback envelope.
            }
          }
          return { ok: false as const, error };
        }
        const output = typeof args.output === 'string' ? args.output : projectRoot;
        return {
          ok: true as const,
          value: {
            root: projectRoot,
            name,
            output,
            artifacts: [`${name}.atlas.png`, `${name}.atlas.meta.json`],
            ...(stdout.length === 0 ? {} : { producer: stdout.join('\n') }),
          },
        };
      })()),
    }),
    'build',
    {
      capabilities: ['asset-atlas-producer'],
      errors: ['atlas-empty-input', 'atlas-size-exceeded', 'atlas-region-mismatch'],
      example: { input: 'assets/frames/*.png', name: 'walk', output: 'dist/assets' },
    },
  );
  const rhi = (
    operation: 'rhi.capture' | 'rhi.summary' | 'rhi.inspect',
    leaf: string,
    summary: string,
  ) =>
    command(
      operation,
      ['debug', 'rhi', leaf],
      operation,
      summary,
      async (args) => {
        const { createCliRhiDebugOperationContext, runRhiDebugCommand } = await import(
          '../commands.js'
        );
        const artifact =
          typeof args.artifact === 'string'
            ? {
                kind: 'rhi-tape' as const,
                source: 'cli',
                path: args.artifact,
                digest: typeof args.digest === 'string' ? args.digest : '',
              }
            : args.artifact;
        const outcome = await runRhiDebugCommand(
          operation,
          { ...args, artifact } as never,
          createCliRhiDebugOperationContext(),
        );
        return outcome.ok
          ? { ok: true, value: JSON.parse(JSON.stringify(outcome.value)) }
          : { ok: false, error: outcome.error };
      },
      'host',
    );
  const profile = (
    operation: 'capture' | 'summary' | 'frame' | 'phase' | 'compare',
    summary: string,
  ) =>
    command(
      `profile.${operation}`,
      ['debug', 'profile', operation],
      `Profile ${operation}`,
      summary,
      async (args) => {
        if (operation === 'capture') {
          return {
            ok: false,
            error: {
              code: 'profile-capture-unavailable',
              expected: 'a live App profiler capability to be attached to the dev instance',
              hint: 'Start a recorder-enabled App host before requesting a profile capture.',
              detail: { operation },
            },
          };
        }
        const { runProfilerCli } = await import('@forgeax/engine-profiler/cli');
        const input =
          operation === 'compare'
            ? ''
            : JSON.stringify((args.capture ?? args.artifact ?? args.input ?? args) as JsonValue);
        const cliArgs: string[] = [operation];
        if (operation === 'compare') {
          if (typeof args.leftFile === 'string') cliArgs.push('--left-file', args.leftFile);
          if (typeof args.rightFile === 'string') cliArgs.push('--right-file', args.rightFile);
        }
        if (operation === 'frame' && typeof args.frameId === 'number') {
          cliArgs.push('--frame-id', String(args.frameId));
        }
        if (operation === 'phase') {
          if (typeof args.source === 'string') cliArgs.push('--source', args.source);
          if (typeof args.phase === 'string') cliArgs.push('--phase', args.phase);
        }
        const result = runProfilerCli(cliArgs, input);
        const raw = result.exitCode === 0 ? result.stdout : result.stderr;
        let parsed: unknown = raw.trim();
        try {
          parsed = JSON.parse(raw) as unknown;
        } catch {
          // Preserve the owning CLI's plain diagnostic when it is not JSON.
        }
        if (result.exitCode === 0) return { ok: true, value: parsed };
        const failure =
          typeof parsed === 'object' && parsed !== null && 'error' in parsed
            ? (parsed as { readonly error: Extract<CommandValue, { readonly ok: false }>['error'] })
                .error
            : undefined;
        return {
          ok: false,
          error: failure ?? {
            code: 'profile-command-failed',
            expected: 'the profiler command to return a structured result',
            hint: 'Inspect the profile artifact and retry the same operation.',
            detail: { output: parsed },
          },
        };
      },
      operation === 'capture' ? 'host' : 'build',
    );
  const debugContributions = [
    offlinePreviewAnalysis,
    rhi('rhi.capture', 'capture', 'Captures one live frame into an ArtifactRef.'),
    rhi('rhi.summary', 'summary', 'Decodes one RHI tape into its FrameModel.'),
    rhi('rhi.inspect', 'inspect', 'Inspects one RHI work item on a fresh replay backend.'),
    profile('capture', 'Captures one bounded CPU profile from a live App host.'),
    profile('summary', 'Projects a profile ArtifactRef into an offline summary.'),
    profile('frame', 'Selects one frame from a profile ArtifactRef.'),
    profile('phase', 'Selects one phase from a profile ArtifactRef.'),
    profile('compare', 'Compares two profile ArtifactRefs without starting a browser.'),
  ];
  return [
    project(
      'project.new',
      ['project', 'new'],
      'Create project',
      'Creates a project from an SDK template.',
      'newCommand',
    ),
    project(
      'project.init',
      ['project', 'init'],
      'Initialize project',
      'Initializes the local project and its dependencies.',
      'initCommand',
    ),
    project(
      'project.check',
      ['project', 'check'],
      'Check project',
      'Runs project diagnostics without starting a live instance.',
      'doctorCommand',
    ),
    project(
      'project.test',
      ['project', 'test'],
      'Test project',
      'Runs the project test gate.',
      'testCommand',
    ),
    project(
      'project.package',
      ['project', 'package'],
      'Package project',
      'Packages the built project for delivery.',
      'packageCommand',
    ),
    project(
      'project.preview',
      ['project', 'preview'],
      'Preview project',
      'Serves the built project for inspection.',
      'previewCommand',
    ),
    project(
      'project.capture',
      ['project', 'capture'],
      'Capture project',
      'Starts a temporary project and captures evidence.',
      'browserCaptureCommand',
    ),
    project(
      'project.engine.status',
      ['project', 'engine', 'status'],
      'Engine status',
      'Reports the project Engine binding.',
      'engineStatusCommand',
    ),
    project(
      'project.engine.use-local',
      ['project', 'engine', 'use-local'],
      'Use local Engine',
      'Binds the project to a local Engine source.',
      'engineUseLocalCommand',
    ),
    project(
      'project.engine.unlink',
      ['project', 'engine', 'unlink'],
      'Unlink Engine',
      'Removes the local Engine binding.',
      'engineUnlinkCommand',
    ),
    project(
      'project.engine.check',
      ['project', 'engine', 'check'],
      'Check Engine',
      'Checks the project Engine binding.',
      'engineDoctorCommand',
    ),
    project(
      'project.skill.install',
      ['project', 'skill', 'install'],
      'Install skills',
      'Installs the project skill surface.',
      'skillInstallCommand',
    ),
    project(
      'project.skill.verify',
      ['project', 'skill', 'verify'],
      'Verify skills',
      'Verifies the project skill surface.',
      'skillVerifyCommand',
    ),
    project(
      'project.plugin.list',
      ['project', 'plugin', 'list'],
      'List project plugins',
      'Lists the persistent project Entry tree.',
      'pluginInspectCommand',
    ),
    project(
      'asset.import',
      ['asset', 'import'],
      'Import asset',
      'Imports a source asset through the project asset authority.',
      'assetAddCommand',
    ),
    project(
      'asset.shader-check',
      ['asset', 'shader', 'check'],
      'Check shader',
      'Checks authored shader sources.',
      'shaderCheckCommand',
    ),
    project(
      'sdk.install',
      ['sdk', 'install'],
      'Install SDK',
      'Installs an SDK into a project directory.',
      'sdkInstallCommand',
    ),
    assetPreview,
    assetAtlas,
    ...debugContributions,
    start,
    live(
      'dev.status',
      ['dev', 'status'],
      'Live status',
      'Reports the persistent instance, load, frame, and unfinished eval state.',
      'status',
    ),
    live(
      'dev.reload',
      ['dev', 'reload'],
      'Reload live project',
      'Replaces the project execution environment and invalidates its old identity.',
      'reload',
    ),
    live(
      'dev.stop',
      ['dev', 'stop'],
      'Stop live project',
      'Destroys the persistent page and project execution environment.',
      'stop',
    ),
    live(
      'dev.eval',
      ['dev', 'eval'],
      'Evaluate live project',
      'Evaluates through the project live inspection capability.',
      'eval',
    ),
    live(
      'dev.camera.get',
      ['dev', 'camera', 'get'],
      'Get observation camera',
      'Reads transient observation camera state from the actual App realm.',
      'camera/get',
    ),
    live(
      'dev.camera.set',
      ['dev', 'camera', 'set'],
      'Set observation camera',
      'Updates transient observation camera state in the actual App realm.',
      'camera/set',
    ),
    live(
      'dev.focus',
      ['dev', 'focus'],
      'Focus observation camera',
      'Focuses the transient observation camera on an actual entity handle.',
      'focus',
    ),
    live(
      'dev.capture',
      ['dev', 'capture'],
      'Capture live project',
      'Captures the held Page after a confirmed submitted frame.',
      'capture',
    ),
  ] as readonly ToolContribution[];
}
