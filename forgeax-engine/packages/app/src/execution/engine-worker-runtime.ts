import { createCatalogSource } from '@forgeax/engine-assets-runtime';
import { type AudioIntent, createAudioIntentBackend } from '@forgeax/engine-audio';
import { createWorldContext, World } from '@forgeax/engine-ecs';
import type { SharedKernelExecutor } from '@forgeax/engine-ecs/shared';
import type { InputBackend, InputBackendSample } from '@forgeax/engine-input';
import type { Context, Plugin } from '@forgeax/engine-plugin';
import type { Renderer } from '@forgeax/engine-render';
import { createDevImportTransport } from '@forgeax/engine-runtime';
import { constructRuntimeRendererHost } from '@forgeax/engine-runtime/internal/renderer-host';
import { createAnimationPayloadLookup } from '../animation-asset-lookup';
import { type AssetRuntimeAssembly, createAssetRuntimeAssembly } from '../assets-runtime-assembly';
import { syncCameraAspect } from '../canvas-policy';
import { workerEngineProfile } from '../internal/worker-engine-profile';
import { type AppObservation, createAppObservation } from '../observation';
import { createRenderFeatureHost } from '../renderer-plugin';
import { commitAttachedWorld, SerializedRebuildQueue } from './attached-world-swap';
import {
  executionBootstrapHostPlugin,
  type PreparedExecutionBootstrap,
  prepareBootstrapEntry,
} from './bootstrap-entry';
import { createKernelPool, type KernelPool } from './kernel-pool';
import type {
  EngineToHostMessage,
  ExecutionFrameMessage,
  ExecutionInitMessage,
  ExecutionInspectMessage,
  ExecutionRebuildMessage,
  HostToEngineMessage,
} from './protocol';

const scope = globalThis as unknown as {
  postMessage(message: EngineToHostMessage): void;
  onmessage: ((event: MessageEvent<HostToEngineMessage>) => void) | null;
  close(): void;
};

let renderer: Renderer | undefined;
let assets: import('@forgeax/engine-assets-runtime').AssetRegistry | undefined;
let currentSample: InputBackendSample = {
  downKeys: new Set(),
  upKeys: new Set(),
  buttons: [false, false, false],
  movementX: 0,
  movementY: 0,
  wheelDelta: 0,
  focused: true,
  pointerLocked: false,
};
let lastFrameId = 0;
let engineCanvas: OffscreenCanvas | undefined;
interface WorkerRealm {
  readonly world: World;
  readonly init: ExecutionInitMessage;
  assetAssembly: AssetRuntimeAssembly | undefined;
  pendingAudioIntents: AudioIntent[];
  kernelPool: KernelPool | undefined;
  pluginContext: Context | undefined;
  observation: AppObservation | undefined;
}

let realm: WorkerRealm | undefined;
const rebuildQueue = new SerializedRebuildQueue();
const inspectionQueue: ExecutionInspectMessage[] = [];
/** Requests that passed the frame-boundary admission point and may still run. */
const activeInspectionIds = new Set<number>();

type WorkerExecuteModule = {
  readonly executeScript: (
    script: string,
    context: {
      readonly world: unknown;
      readonly renderer: unknown;
      readonly assets: unknown;
      readonly simulation: unknown;
      readonly execution: unknown;
    },
  ) => Promise<
    { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: unknown }
  >;
};

let executeScriptPromise: Promise<WorkerExecuteModule> | undefined;

function serializableEvalError(error: unknown): { readonly code: string; readonly hint: string } {
  if (error !== null && typeof error === 'object') {
    const candidate = error as { readonly code?: unknown; readonly message?: unknown };
    return {
      code: typeof candidate.code === 'string' ? candidate.code : 'worker-eval-error',
      hint: typeof candidate.message === 'string' ? candidate.message : String(error),
    };
  }
  return { code: 'worker-eval-error', hint: String(error) };
}

async function executeInspection(job: ExecutionInspectMessage, target: WorkerRealm): Promise<void> {
  if (job.worldIdentity !== target.world.identity) {
    scope.postMessage({
      kind: 'inspect-result',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
      result: {
        ok: false,
        error: {
          code: 'live-world-stale',
          hint: 'The inspection belongs to an older World; fetch status and retry.',
          detail: { expected: job.worldIdentity, actual: target.world.identity },
        },
      },
    });
    return;
  }
  activeInspectionIds.add(job.requestId);
  try {
    // The queue is admitted only from runFrame. This is the authoritative
    // start witness consumed by the browser relay for cancellation semantics.
    scope.postMessage({
      kind: 'inspect-started',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
    });
    executeScriptPromise ??= import('@forgeax/engine-remote/execute').then(
      (module) => module as unknown as WorkerExecuteModule,
    );
    const module = await executeScriptPromise;
    const simulation = {
      world: target.world,
      renderer,
      assets,
      execution: {
        report: () => ({
          actualTier: target.init.tier,
          engine: { realm: 'worker' },
          world: { identity: target.world.identity },
        }),
      },
    };
    let observation: AppObservation | undefined;
    if (renderer !== undefined) {
      if (target.observation === undefined) {
        target.observation = createAppObservation(target.world, renderer, simulation.execution);
      }
      observation = target.observation;
    }
    const result = await module.executeScript(job.code, {
      world: target.world,
      renderer,
      assets,
      simulation: { ...simulation, observation },
      execution: simulation.execution,
    });
    scope.postMessage({
      kind: 'inspect-result',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
      result,
    });
  } catch (error) {
    scope.postMessage({
      kind: 'inspect-result',
      requestId: job.requestId,
      worldIdentity: target.world.identity,
      result: { ok: false, error: serializableEvalError(error) },
    });
  } finally {
    activeInspectionIds.delete(job.requestId);
  }
}

const inputBackend: InputBackend = {
  sample: () => currentSample,
  detach: () => {},
};

function sharedKernelPlugin(target: WorkerRealm): Plugin {
  return {
    name: 'shared-kernel-executor',
    inject: ['world'],
    apply(ctx) {
      const executor: SharedKernelExecutor = {
        warmup(kernel) {
          target.kernelPool ??= createKernelPool();
          target.kernelPool.warmup?.(kernel);
        },
        execute(kernel, spans) {
          target.kernelPool ??= createKernelPool();
          return target.kernelPool.execute(kernel, spans);
        },
      };
      ctx.effect(() => {
        ctx.world.insertResource('SharedKernelExecutor', executor);
        return () => {
          ctx.world.removeResource('SharedKernelExecutor');
          target.kernelPool?.dispose();
          target.kernelPool = undefined;
        };
      }, 'execution/shared-kernel');
    },
  };
}

function serializableCause(cause: unknown): { readonly name: string; readonly message: string } {
  return cause instanceof Error
    ? { name: cause.name, message: cause.message }
    : { name: 'Error', message: String(cause) };
}

function serializableDetail(cause: unknown): unknown {
  if (cause instanceof Error) return serializableCause(cause);
  if (Array.isArray(cause)) return cause.map(serializableDetail);
  if (typeof cause === 'object' && cause !== null) {
    return Object.fromEntries(
      Object.entries(cause).map(([key, value]) => [key, serializableDetail(value)]),
    );
  }
  return cause;
}

function postFault(
  source: 'bootstrap' | 'runtime' | 'world' | 'rebuild',
  code: string,
  expected: string,
  hint: string,
  cause: unknown,
  partialWrite = false,
): void {
  scope.postMessage({
    kind: 'fault',
    worldIdentity: realm?.world.identity ?? null,
    source,
    code,
    expected,
    hint,
    detail: serializableDetail(cause),
    partialWrite,
    retryable: false,
  });
}

async function disposeRealm(target: WorkerRealm): Promise<void> {
  target.observation?.release();
  target.observation = undefined;
  await target.pluginContext?.fiber.dispose();
  target.pluginContext = undefined;
  target.assetAssembly?.dispose();
  target.assetAssembly = undefined;
  target.pendingAudioIntents = [];
}

function postBootstrapFault(error: {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: unknown;
}): void {
  postFault('bootstrap', error.code, error.expected, error.hint, error.detail);
}

async function createRealm(init: ExecutionInitMessage): Promise<boolean> {
  const preparedResult = await prepareBootstrapEntry(init.bootstrapUrl, init.bootstrapData);
  if (!preparedResult.ok) {
    postBootstrapFault(preparedResult.error);
    return false;
  }
  const prepared: PreparedExecutionBootstrap = preparedResult.value;
  const nextWorld = new World({
    ...(init.time !== undefined ? { time: init.time } : {}),
    storage: init.tier === 'shared' ? 'shared' : 'local',
  });
  const candidate: WorkerRealm = {
    world: nextWorld,
    init,
    assetAssembly: undefined,
    pendingAudioIntents: [],
    kernelPool: undefined,
    pluginContext: undefined,
    observation: undefined,
  };
  const audioBackend = createAudioIntentBackend({
    emit: (intent) => candidate.pendingAudioIntents.push(intent),
  });
  let candidateRenderer: Renderer | undefined;
  let rendererLifecycleTransferred = false;
  const previousRenderer = renderer;
  let previousSurfaceReleased = false;
  try {
    if (previousRenderer !== undefined) {
      const released = previousRenderer.releaseSurface();
      if (!released.ok) throw released.error;
      previousSurfaceReleased = true;
    }
    const runtimeBinding = init.assetCatalog?.runtimeBinding;
    const bundler =
      init.shaderManifestUrl === undefined &&
      init.build === undefined &&
      runtimeBinding === undefined
        ? undefined
        : {
            ...(init.shaderManifestUrl === undefined
              ? {}
              : { shaderManifestUrl: init.shaderManifestUrl }),
            ...(init.build === undefined ? {} : { build: init.build }),
            ...(runtimeBinding === undefined
              ? {}
              : { importTransport: createDevImportTransport(runtimeBinding) }),
          };
    const constructed = await constructRuntimeRendererHost(
      init.canvas,
      prepared.features === undefined ? {} : { features: prepared.features },
      bundler,
    );
    if (!constructed.ok) throw constructed.error;
    candidateRenderer = constructed.value.renderer;
    assets = constructed.value.assets;
    const catalogSource =
      init.assetCatalog === undefined
        ? undefined
        : createCatalogSource({
            url: init.assetCatalog.url,
            ...(init.assetCatalog.expectedScope === undefined
              ? {}
              : { expectedScope: init.assetCatalog.expectedScope }),
          });
    const assetAssemblyResult = createAssetRuntimeAssembly(assets, {
      ...(catalogSource === undefined ? {} : { catalogSource }),
      ...(runtimeBinding === undefined ? {} : { runtimeBinding }),
    });
    if (!assetAssemblyResult.ok) throw assetAssemblyResult.error;
    candidate.assetAssembly = assetAssemblyResult.value;
    rendererLifecycleTransferred = true;
    const pluginContext = await createWorldContext(
      nextWorld,
      workerEngineProfile({
        renderer: candidateRenderer,
        rendererFeatureHost: createRenderFeatureHost(constructed.value.featureHost),
        assets,
        input: inputBackend,
        audio: audioBackend,
        assetAssembly: assetAssemblyResult.value,
        animationPayloads: createAnimationPayloadLookup(assetAssemblyResult.value.registry),
        extensions: [
          ...(init.tier === 'shared' ? [sharedKernelPlugin(candidate)] : []),
          executionBootstrapHostPlugin({
            canvas: init.canvas,
            ...(init.bootstrapPort === undefined ? {} : { port: init.bootstrapPort }),
            setPointerLockAllowed(allowed): void {
              scope.postMessage({
                kind: 'host-control',
                command: 'set-pointer-lock-allowed',
                allowed,
              });
            },
          }),
          ...(prepared.plugins ?? []),
        ],
      }),
    );
    candidate.pluginContext = pluginContext;
    const activeRenderer = candidateRenderer;
    const previousRealm = realm;
    const committed = await commitAttachedWorld(candidateRenderer, nextWorld, async () => {
      await candidate.kernelPool?.ready();
      return true;
    });
    if (!committed) {
      await disposeRealm(candidate);
      if (previousSurfaceReleased) previousRenderer?.restoreSurface();
      return false;
    }
    realm = candidate;
    renderer = activeRenderer;
    lastFrameId = 0;
    if (previousRealm !== undefined) await disposeRealm(previousRealm);
    return true;
  } catch (cause) {
    await disposeRealm(candidate);
    if (!rendererLifecycleTransferred) candidateRenderer?.dispose();
    if (previousSurfaceReleased) previousRenderer?.restoreSurface();
    throw cause;
  }
}

async function initialize(message: ExecutionInitMessage): Promise<void> {
  try {
    engineCanvas = message.canvas;
    if (!(await createRealm(message))) return;
    scope.postMessage({
      kind: 'ready',
      worldIdentity: realm?.world.identity ?? '',
      realm: 'worker',
      workerWebGpu: typeof navigator === 'object' && navigator.gpu !== undefined,
    });
  } catch (cause) {
    postFault(
      'bootstrap',
      'app-execution-bootstrap-failed',
      'Engine Worker creates a realm-local World, Renderer and GPU owner',
      'inspect the worker bootstrap cause and module URL',
      cause,
    );
  }
}

async function runFrame(message: ExecutionFrameMessage): Promise<void> {
  const activeRealm = realm;
  if (activeRealm === undefined || renderer === undefined) return;
  const { world } = activeRealm;
  if (message.worldIdentity !== world.identity || message.frameId <= lastFrameId) return;
  if (renderer.state() !== 'alive') return;
  currentSample = message.inputSample;
  const canvasWidth =
    Number.isFinite(message.canvasWidth) && message.canvasWidth > 0
      ? Math.max(1, Math.floor(message.canvasWidth))
      : undefined;
  const canvasHeight =
    Number.isFinite(message.canvasHeight) && message.canvasHeight > 0
      ? Math.max(1, Math.floor(message.canvasHeight))
      : undefined;
  if (canvasWidth !== undefined && canvasHeight !== undefined) {
    if (engineCanvas !== undefined) {
      if (engineCanvas.width !== canvasWidth) engineCanvas.width = canvasWidth;
      if (engineCanvas.height !== canvasHeight) engineCanvas.height = canvasHeight;
    }
    syncCameraAspect(world, canvasWidth, canvasHeight);
  }
  const inspections = inspectionQueue.splice(0, inspectionQueue.length);
  // Admission happens at a frame boundary, but the async script must not hold
  // the Worker frame credit open while it awaits. The DevKit owner tracks the
  // same promise and blocks conflicting observation writes until it completes.
  for (const inspection of inspections) void executeInspection(inspection, activeRealm);
  const started = performance.now();
  try {
    const update = world.update(message.deltaSeconds);
    if (!update.ok) throw update.error;
    if (world.execution.health === 'poisoned') {
      const fault = world.execution.fault;
      postFault(
        'world',
        fault?.code ?? 'world-poisoned',
        'World remains healthy through update',
        'rebuild the poisoned World explicitly',
        fault,
        fault?.partialWrite ?? true,
      );
      return;
    }
    const updateFinished = performance.now();
    const attached = renderer.attach(world);
    if (!attached.ok) throw attached.error;
    realm?.observation?.prepareFrame();
    const draw = renderer.draw({
      leases: [attached.value],
      camera: { lease: attached.value },
      environment: { lease: attached.value },
    });
    if (!draw.ok) throw draw.error;
    lastFrameId = message.frameId;
    const kernelDispatch = activeRealm.kernelPool?.takeLastDispatch() ?? null;
    const audioIntents = activeRealm.pendingAudioIntents;
    activeRealm.pendingAudioIntents = [];
    scope.postMessage({
      kind: 'frame-complete',
      worldIdentity: world.identity,
      frameId: message.frameId,
      deviceGeneration: draw.value.deviceGeneration,
      engineUpdateMs: updateFinished - started,
      kernelWaitMs: kernelDispatch?.waitMs ?? 0,
      ...(audioIntents.length > 0 ? { audioIntents } : {}),
      ...(kernelDispatch !== null
        ? {
            kernelDispatch: {
              eligible: true,
              usedShared: kernelDispatch.mode === 'shared',
              reason:
                kernelDispatch.mode === 'shared' ? ('shared' as const) : ('forced-inline' as const),
              dispatched: kernelDispatch.dispatched,
              completed: kernelDispatch.completed,
            },
          }
        : {}),
    });
  } catch (cause) {
    const fault = world.execution.fault;
    postFault(
      fault === null ? 'runtime' : 'world',
      fault?.code ?? 'app-system-update-failed',
      'World update completes before Renderer draw',
      fault === null ? 'inspect the runtime cause' : 'rebuild the poisoned World explicitly',
      cause,
      fault?.partialWrite ?? false,
    );
  }
}

async function rebuild(message: ExecutionRebuildMessage): Promise<void> {
  const activeRealm = realm;
  if (
    activeRealm === undefined ||
    renderer === undefined ||
    message.worldIdentity !== activeRealm.world.identity
  )
    return;
  const previousWorldIdentity = activeRealm.world.identity;
  try {
    const cancelled = inspectionQueue.splice(0, inspectionQueue.length);
    for (const job of cancelled) {
      scope.postMessage({
        kind: 'inspect-result',
        requestId: job.requestId,
        worldIdentity: previousWorldIdentity,
        result: {
          ok: false,
          error: {
            code: 'live-world-stale',
            hint: 'The World was rebuilt before inspection admission.',
            detail: { worldIdentity: previousWorldIdentity },
          },
        },
      });
    }
    if (engineCanvas === undefined) return;
    const init: ExecutionInitMessage = { ...activeRealm.init, canvas: engineCanvas };
    if (!(await createRealm(init))) return;
    scope.postMessage({
      kind: 'rebuilt',
      previousWorldIdentity,
      worldIdentity: realm?.world.identity ?? '',
    });
  } catch (cause) {
    postFault(
      'rebuild',
      'app-execution-rebuild-failed',
      'bootstrap creates a fresh World identity',
      'inspect the bootstrap cause or create a new App',
      cause,
    );
  }
}

scope.onmessage = (event): void => {
  const message = event.data;
  if (message.kind === 'init') void initialize(message);
  else if (message.kind === 'frame') void runFrame(message);
  else if (message.kind === 'inspect') inspectionQueue.push(message);
  else if (message.kind === 'inspect-cancel') {
    const index = inspectionQueue.findIndex((job) => job.requestId === message.requestId);
    if (index >= 0) {
      const [cancelled] = inspectionQueue.splice(index, 1);
      if (cancelled !== undefined) {
        scope.postMessage({
          kind: 'inspect-canceled',
          requestId: cancelled.requestId,
          worldIdentity: realm?.world.identity ?? cancelled.worldIdentity,
          admitted: false,
        });
      }
    } else {
      // A request absent from the queue has either started or already posted
      // its terminal result. Keep the caller attached to that execution rather
      // than falsely claiming it was cancelled before admission.
      scope.postMessage({
        kind: 'inspect-canceled',
        requestId: message.requestId,
        worldIdentity: realm?.world.identity ?? message.worldIdentity,
        admitted: true,
      });
    }
  } else if (message.kind === 'rebuild') {
    void rebuildQueue.enqueue(() => rebuild(message));
  } else if (message.kind === 'dispose') {
    void (async () => {
      if (realm !== undefined) {
        await disposeRealm(realm);
        realm = undefined;
      }
      scope.close();
    })();
  }
};
