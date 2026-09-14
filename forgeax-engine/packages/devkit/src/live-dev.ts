import { isLiveDevInputChange } from './live-dev-watch.js';
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type FSWatcher, watch } from 'node:fs';
import { access, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { dirname, resolve } from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import {
  type BrowserCapture,
  createBrowserCapture,
  type SoftwareBrowserSession,
} from './software-capture.js';

export interface LiveDevStatus {
  readonly schemaVersion: '1.0.0';
  readonly root: string;
  readonly endpoint: string;
  readonly pid: number;
  readonly generation: number;
  readonly instanceId: string;
  readonly loadId: string;
  readonly phase: 'starting' | 'ready' | 'waiting' | 'reloading' | 'failed' | 'stopped';
  readonly url: string | undefined;
  readonly unfinishedEval: boolean;
  readonly frameId: number | undefined;
  readonly worldIdentity: string | undefined;
  readonly executionTier: string | undefined;
  readonly backend: LiveDevBackend;
  readonly bridgeConnected: boolean;
  readonly error: string | undefined;
}

export type LiveDevBackend = 'auto' | 'hardware' | 'software';
export type LiveDevExecutionTier = 'main-serial' | 'engine-worker';

interface LiveDevSessionFile {
  readonly root: string;
  readonly sessionPath: string;
  readonly endpoint: string;
  readonly pid: number;
  readonly instanceId: string;
  readonly loadId: string;
}

type LiveOperation =
  | 'status'
  | 'reload'
  | 'stop'
  | 'capture'
  | 'eval'
  | 'camera/get'
  | 'camera/set'
  | 'focus';

interface LiveDevDaemonState {
  readonly root: string;
  readonly sessionPath: string;
  readonly browser: BrowserCapture;
  readonly backend: LiveDevBackend;
  readonly requestedExecutionTier: LiveDevExecutionTier;
  session: SoftwareBrowserSession | undefined;
  projectUrl: string | undefined;
  status: LiveDevStatus;
  evalRunning: boolean;
  server: ReturnType<typeof createServer> | undefined;
  bridgeServer: WebSocketServer | undefined;
  bridge: WebSocket | undefined;
  bridgeNextId: number;
  bridgePending: Map<
    number,
    {
      readonly resolve: (value: unknown) => void;
      readonly reject: (error: unknown) => void;
      readonly timer: ReturnType<typeof setTimeout> | undefined;
      readonly progress: { started: boolean };
      cancelResolve: ((admitted: boolean) => void) | undefined;
    }
  >;
  projectProcess: ChildProcess | undefined;
  watcher: FSWatcher | undefined;
  reloadTimer: ReturnType<typeof setTimeout> | undefined;
  reloadInFlight: Promise<void> | undefined;
  reloadRequested: boolean;
}

type InspectionRequest =
  | { readonly operation: 'camera/get'; readonly args: Record<string, unknown> }
  | { readonly operation: 'camera/set'; readonly args: Record<string, unknown> }
  | { readonly operation: 'focus'; readonly args: Record<string, unknown> };

function sessionPath(root: string): string {
  return resolve(root, '.forgeax', 'dev-session.json');
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(`${JSON.stringify(value)}\n`);
}

async function body(request: IncomingMessage): Promise<unknown> {
  let raw = '';
  for await (const chunk of request) raw += String(chunk);
  if (raw.trim().length === 0) return {};
  return JSON.parse(raw) as unknown;
}

function commandError(code: string, hint: string, detail: Record<string, unknown> = {}) {
  return { code, expected: 'the live DevKit service to accept the request', hint, detail };
}

async function writeSessionFile(state: LiveDevDaemonState): Promise<void> {
  await mkdir(dirname(state.sessionPath), { recursive: true });
  await writeFile(
    state.sessionPath,
    `${JSON.stringify({
      root: state.root,
      sessionPath: state.sessionPath,
      endpoint: state.status.endpoint,
      pid: state.status.pid,
      instanceId: state.status.instanceId,
      loadId: state.status.loadId,
    } satisfies LiveDevSessionFile)}\n`,
    'utf8',
  );
}

async function waitForFirstFrame(session: SoftwareBrowserSession): Promise<boolean> {
  try {
    await session.page.waitForFunction(
      () => document.documentElement.dataset.forgeaxFrameSubmitted !== undefined,
      undefined,
      { timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function submittedFrameId(session: SoftwareBrowserSession): Promise<number | undefined> {
  const value = await session.page.evaluate(
    () => document.documentElement.dataset.forgeaxFrameSubmitted,
  );
  if (value === undefined) return undefined;
  const frame = Number(value);
  return Number.isSafeInteger(frame) ? frame : undefined;
}

async function waitForFrameAfter(
  session: SoftwareBrowserSession,
  previous: number | undefined,
): Promise<void> {
  await session.page.waitForFunction(
    (before) => Number(document.documentElement.dataset.forgeaxFrameSubmitted) > (before ?? 0),
    previous,
    { timeout: 120_000 },
  );
}

function assertLiveIdentity(
  state: LiveDevDaemonState,
  args: Record<string, unknown>,
): ReturnType<typeof commandError> | undefined {
  const instance =
    typeof args.instanceId === 'string'
      ? args.instanceId
      : typeof args.instance === 'string'
        ? args.instance
        : undefined;
  if (instance === undefined) {
    return commandError(
      'live-instance-required',
      'Pass the current instanceId (or instance) from dev status before using this operation.',
    );
  }
  if (
    instance !== state.status.instanceId ||
    (args.loadId !== undefined && args.loadId !== state.status.loadId)
  ) {
    return commandError(
      'live-instance-stale',
      'The request belongs to an older live instance; fetch dev status and retry.',
      { instanceId: state.status.instanceId, loadId: state.status.loadId },
    );
  }
  if (typeof args.worldIdentity === 'string' && args.worldIdentity !== state.status.worldIdentity) {
    return commandError(
      'live-world-stale',
      'The request belongs to an older World; fetch dev status and retry.',
      { worldIdentity: state.status.worldIdentity },
    );
  }
  return undefined;
}

async function refreshFrameStatus(state: LiveDevDaemonState): Promise<void> {
  if (state.session === undefined) return;
  const frameId = await submittedFrameId(state.session);
  if (frameId !== undefined) state.status = { ...state.status, frameId };
}

function bridgeError(code: string, hint: string): Error & { readonly code: string } {
  const error = new Error(hint) as Error & { code: string };
  error.code = code;
  return error;
}

interface BridgeCall {
  readonly promise: Promise<unknown>;
  readonly started: () => boolean;
  cancel(): Promise<boolean>;
}

function bridgeCall(
  state: LiveDevDaemonState,
  code: string,
  timeoutMs: number | null = 10_000,
): BridgeCall {
  if (state.bridge?.readyState !== WebSocket.OPEN) {
    return {
      promise: Promise.reject(
        bridgeError(
          'live-app-bridge-unavailable',
          'The actual App execution bridge is not connected.',
        ),
      ),
      started: () => false,
      cancel: () => Promise.resolve(false),
    };
  }
  const id = state.bridgeNextId++;
  const progress = { started: false };
  const promise = new Promise((resolveResult, rejectResult) => {
    const timer =
      timeoutMs === null
        ? undefined
        : setTimeout(() => {
            state.bridgePending.delete(id);
            rejectResult(
              bridgeError(
                'live-app-bridge-timeout',
                'The actual App execution bridge did not answer before the deadline.',
              ),
            );
          }, timeoutMs);
    state.bridgePending.set(id, {
      resolve: resolveResult,
      reject: rejectResult,
      timer,
      progress,
      cancelResolve: undefined,
    });
    try {
      state.bridge?.send(
        JSON.stringify({
          type: 'eval',
          id,
          code,
          ...(state.status.worldIdentity === undefined
            ? {}
            : { worldIdentity: state.status.worldIdentity }),
        }),
      );
    } catch (error) {
      if (timer !== undefined) clearTimeout(timer);
      state.bridgePending.delete(id);
      rejectResult(error);
    }
  }).then((payload) => {
    if (payload !== null && typeof payload === 'object' && Reflect.get(payload, 'ok') === false) {
      const error = Reflect.get(payload, 'error');
      const errorRecord =
        error !== null && typeof error === 'object'
          ? (error as { readonly code?: unknown; readonly hint?: unknown })
          : undefined;
      throw bridgeError(
        typeof errorRecord?.code === 'string' ? errorRecord.code : 'live-app-eval-failed',
        typeof errorRecord?.hint === 'string' ? errorRecord.hint : 'The App evaluation failed.',
      );
    }
    return payload !== null && typeof payload === 'object' && Reflect.get(payload, 'ok') === true
      ? Reflect.get(payload, 'value')
      : payload;
  });
  return {
    promise,
    started: () => progress.started,
    cancel: () => {
      const pending = state.bridgePending.get(id);
      if (pending === undefined) return Promise.resolve(true);
      const outcome = new Promise<boolean>((resolve) => {
        pending.cancelResolve = resolve;
      });
      try {
        state.bridge?.send(JSON.stringify({ type: 'cancel', id }));
      } catch {
        pending.cancelResolve?.(true);
        pending.cancelResolve = undefined;
      }
      return outcome;
    },
  };
}

function bridgeEval(
  state: LiveDevDaemonState,
  code: string,
  timeoutMs: number | null = 10_000,
): Promise<unknown> {
  return bridgeCall(state, code, timeoutMs).promise;
}

async function refreshBridgeStatus(state: LiveDevDaemonState): Promise<boolean> {
  if (state.bridge?.readyState !== WebSocket.OPEN) {
    state.status = { ...state.status, bridgeConnected: false };
    return false;
  }
  const value = await bridgeEval(
    state,
    'return { worldIdentity: simulation.world.identity, execution: simulation.execution.report(), tier: simulation.execution.report().actualTier };',
  );
  const record = value as {
    readonly worldIdentity?: unknown;
    readonly execution?: unknown;
    readonly tier?: unknown;
  };
  if (typeof record.worldIdentity !== 'string')
    throw bridgeError(
      'live-world-identity-missing',
      'The App bridge did not publish a World identity.',
    );
  const worldReplaced =
    state.status.worldIdentity !== undefined && state.status.worldIdentity !== record.worldIdentity;
  state.status = {
    ...state.status,
    ...(worldReplaced
      ? {
          generation: state.status.generation + 1,
          instanceId: randomUUID(),
          loadId: randomUUID(),
          phase: 'ready' as const,
          error: undefined,
        }
      : {}),
    phase: state.status.phase === 'stopped' ? 'stopped' : 'ready',
    worldIdentity: record.worldIdentity,
    executionTier: typeof record.tier === 'string' ? record.tier : undefined,
    bridgeConnected: true,
  };
  if (worldReplaced) await writeSessionFile(state);
  return true;
}

async function requireCurrentBridge(
  state: LiveDevDaemonState,
  response: ServerResponse,
): Promise<boolean> {
  try {
    if (await refreshBridgeStatus(state)) return true;
  } catch (error) {
    jsonResponse(response, 409, {
      ok: false,
      error: commandError(
        typeof (error as { readonly code?: unknown })?.code === 'string'
          ? ((error as { readonly code: string }).code ?? 'live-app-bridge-unavailable')
          : 'live-app-bridge-unavailable',
        error instanceof Error
          ? error.message
          : 'The actual App execution realm is not available for this request.',
      ),
    });
    return false;
  }
  jsonResponse(response, 409, {
    ok: false,
    error: commandError(
      'live-app-bridge-unavailable',
      'The actual App execution realm is not connected; wait for dev status to report ready.',
    ),
  });
  return false;
}

function rejectBridgePending(state: LiveDevDaemonState, error: unknown): void {
  for (const pending of state.bridgePending.values()) {
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.cancelResolve?.(false);
    pending.reject(error);
  }
  state.bridgePending.clear();
}

function installBridgeRelay(state: LiveDevDaemonState): void {
  const server = state.server;
  if (server === undefined) return;
  const bridgeServer = new WebSocketServer({ noServer: true });
  state.bridgeServer = bridgeServer;
  server.on('upgrade', (request, socket, head) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname !== '/bridge') {
      socket.destroy();
      return;
    }
    bridgeServer.handleUpgrade(request, socket, head, (client) =>
      bridgeServer.emit('connection', client, request),
    );
  });
  bridgeServer.on('connection', (client: WebSocket) => {
    state.bridge?.close();
    state.bridge = client;
    state.status = { ...state.status, bridgeConnected: true };
    client.on('message', (raw) => {
      let message: {
        readonly type?: string;
        readonly id?: number;
        readonly payload?: unknown;
        readonly admitted?: boolean;
      };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        return;
      }
      const id = message.id;
      if (id === undefined || !Number.isSafeInteger(id)) return;
      const pending = state.bridgePending.get(id);
      if (pending === undefined) return;
      if (message.type === 'started') {
        pending.progress.started = true;
        return;
      }
      if (message.type === 'canceled') {
        const admitted = message.admitted === true;
        pending.cancelResolve?.(admitted);
        pending.cancelResolve = undefined;
        if (!admitted) {
          if (pending.timer !== undefined) clearTimeout(pending.timer);
          state.bridgePending.delete(id);
          pending.reject(
            bridgeError(
              'live-eval-cancelled-before-execution',
              'The evaluation was cancelled before it started.',
            ),
          );
        } else {
          pending.progress.started = true;
        }
        return;
      }
      if (message.type !== 'result') return;
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      state.bridgePending.delete(id);
      pending.cancelResolve?.(true);
      pending.resolve(message.payload);
    });
    client.on('close', () => {
      if (state.bridge === client) state.bridge = undefined;
      state.status = {
        ...state.status,
        bridgeConnected: false,
        phase: state.status.phase === 'stopped' ? 'stopped' : 'waiting',
      };
      rejectBridgePending(
        state,
        bridgeError(
          'live-app-bridge-disconnected',
          'The actual App execution bridge disconnected.',
        ),
      );
    });
    client.on('error', () => undefined);
  });
}

async function openSession(state: LiveDevDaemonState): Promise<void> {
  const loadId = randomUUID();
  const instanceId = randomUUID();
  state.status = {
    ...state.status,
    instanceId,
    loadId,
    generation: state.status.generation + 1,
    phase: 'starting',
    unfinishedEval: false,
    bridgeConnected: false,
    worldIdentity: undefined,
    executionTier: undefined,
    error: undefined,
  };
  await writeSessionFile(state);
  try {
    await replaceProjectProcess(state, state.status.generation);
    state.session = await state.browser.open({
      backend: state.backend,
      headless: process.env.FORGEAX_DEV_HEADLESS === 'true',
      launchProfile: 'development',
      ...(state.projectUrl === undefined ? {} : { serverUrl: state.projectUrl }),
    });
    const firstFrame = await waitForFirstFrame(state.session);
    if (!firstFrame || !(await refreshBridgeStatus(state).catch(() => false))) {
      state.status = {
        ...state.status,
        phase: 'waiting',
        url: state.session.url,
        frameId: await submittedFrameId(state.session),
        error: 'live-app-bridge-unavailable: the actual App execution realm has not connected',
      };
    } else {
      state.status = {
        ...state.status,
        phase: 'ready',
        url: state.session.url,
        frameId: await submittedFrameId(state.session),
      };
    }
  } catch (error) {
    await stopProjectProcess(state);
    state.status = {
      ...state.status,
      phase: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await writeSessionFile(state);
}

async function reloadSession(state: LiveDevDaemonState): Promise<void> {
  if (state.reloadInFlight !== undefined) {
    state.reloadRequested = true;
    return state.reloadInFlight;
  }
  const operation = (async () => {
    do {
      state.reloadRequested = false;
      await reloadSessionOwned(state);
    } while (state.reloadRequested);
  })();
  state.reloadInFlight = operation.finally(() => {
    state.reloadInFlight = undefined;
  });
  return state.reloadInFlight;
}

async function reloadSessionOwned(state: LiveDevDaemonState): Promise<void> {
  state.status = {
    ...state.status,
    phase: 'reloading',
    generation: state.status.generation + 1,
    instanceId: randomUUID(),
    loadId: randomUUID(),
  };
  await writeSessionFile(state);
  rejectBridgePending(
    state,
    bridgeError('live-reload-cancelled', 'The previous App execution was destroyed by reload.'),
  );
  state.bridge?.close();
  await stopProjectProcess(state);
  await state.session?.close();
  state.session = undefined;
  state.evalRunning = false;
  state.status = { ...state.status, unfinishedEval: false };
  await openSession(state);
}

function watchProjectInputs(state: LiveDevDaemonState): void {
  try {
    state.watcher = watch(state.root, { recursive: true }, (_event, filename) => {
      if (!isLiveDevInputChange(filename)) return;
      if (state.reloadTimer !== undefined) clearTimeout(state.reloadTimer);
      state.reloadTimer = setTimeout(() => {
        state.reloadTimer = undefined;
        void reloadSession(state).catch((error) => {
          state.status = {
            ...state.status,
            phase: 'failed',
            error: error instanceof Error ? error.message : String(error),
          };
          void writeSessionFile(state);
        });
      }, 200);
    });
  } catch {
    // Some Node platforms do not implement recursive directory watching. The
    // explicit reload boundary remains available and is reported by status.
  }
}

async function stopProjectProcess(state: LiveDevDaemonState): Promise<void> {
  const child = state.projectProcess;
  state.projectProcess = undefined;
  if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveStop();
    }, 2_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
    child.kill('SIGTERM');
  });
}

async function replaceProjectProcess(state: LiveDevDaemonState, generation: number): Promise<void> {
  await stopProjectProcess(state);
  const entry = process.argv[1];
  if (entry === undefined)
    throw new Error('live project process requires the DevKit CLI entrypoint');
  const child = spawn(
    process.execPath,
    [entry, '--__forgeax-live-project', state.root, String(generation)],
    {
      env: {
        ...process.env,
        VITE_FORGEAX_ENGINE_BRIDGE: '1',
        VITE_FORGEAX_ENGINE_BRIDGE_PORT: new URL(state.status.endpoint).port,
        VITE_FORGEAX_EXECUTION_TIER:
          state.requestedExecutionTier === 'engine-worker' ? 'engine-worker' : 'main-serial',
        FORGEAX_DEV_EXECUTION: state.requestedExecutionTier,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  state.projectProcess = child;
  await new Promise<void>((resolveReady, rejectReady) => {
    let output = '';
    // A cold SDK tree may need to build the shader and asset closure before Vite
    // can publish its ready line. The persistent service owns that work, so a
    // short CLI-style deadline would turn a healthy cold start into a false
    // failed instance. Keep the bound finite while allowing one cold build.
    const timer = setTimeout(
      () => rejectReady(new Error('live project backend build timed out')),
      300_000,
    );
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      output += chunk;
      const lines = output.split('\n');
      output = lines.pop() ?? '';
      for (const line of lines) {
        try {
          const result = JSON.parse(line) as {
            readonly ready?: boolean;
            readonly error?: string;
            readonly generation?: number;
            readonly url?: string;
          };
          if (result.ready === true && result.generation === generation) {
            clearTimeout(timer);
            state.projectUrl = result.url;
            resolveReady();
            return;
          }
          if (result.error !== undefined) {
            clearTimeout(timer);
            rejectReady(new Error(result.error));
            return;
          }
        } catch {
          // Preserve non-JSON build diagnostics until a structured terminal line.
        }
      }
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectReady(error);
    });
    child.once('exit', (code) => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        rejectReady(new Error(`live project backend exited ${code}`));
      }
    });
  });
}

/** Internal dev resource entry; it is never a public command. */
export async function runLiveProjectProcess(
  rootInput: string,
  generationInput: string,
): Promise<void> {
  const root = resolve(rootInput);
  const generation = Number(generationInput);
  const { disposeDevKitHosts, startDevProjectWithHost } = await import('./host.js');
  const built = await startDevProjectWithHost({ root, json: true });
  if (!built.ok) {
    process.stdout.write(`${JSON.stringify({ error: built.error.hint, generation })}\n`);
    process.exitCode = 1;
    return;
  }
  const url =
    built.ok &&
    built.value !== null &&
    typeof built.value === 'object' &&
    'urls' in built.value &&
    built.value.urls !== null &&
    typeof built.value.urls === 'object' &&
    'local' in built.value.urls &&
    Array.isArray(built.value.urls.local)
      ? built.value.urls.local[0]
      : undefined;
  process.stdout.write(`${JSON.stringify({ ready: true, generation, url })}\n`);
  await new Promise<void>((resolveExit) => {
    const stop = (): void => {
      void disposeDevKitHosts().finally(resolveExit);
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  });
}

async function handleRequest(
  state: LiveDevDaemonState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  let evalIdentity: { readonly instanceId: string; readonly loadId: string } | undefined;
  if (request.method === 'GET' && url.pathname === '/status') {
    await refreshBridgeStatus(state).catch(() => undefined);
    await refreshFrameStatus(state);
    jsonResponse(response, 200, { ok: true, value: state.status });
    return;
  }
  if (request.method !== 'POST') {
    jsonResponse(response, 405, {
      ok: false,
      error: commandError(
        'live-method-not-allowed',
        'Use GET /status or a supported POST operation.',
      ),
    });
    return;
  }
  try {
    if (url.pathname === '/reload') {
      await reloadSession(state);
      jsonResponse(response, 200, { ok: true, value: state.status });
      return;
    }
    if (url.pathname === '/stop') {
      state.status = {
        ...state.status,
        phase: 'stopped',
        generation: state.status.generation + 1,
        instanceId: randomUUID(),
        loadId: randomUUID(),
      };
      state.evalRunning = false;
      state.status = { ...state.status, unfinishedEval: false };
      await writeSessionFile(state);
      await state.session?.close();
      rejectBridgePending(
        state,
        bridgeError('live-stop-cancelled', 'The live App execution was destroyed by stop.'),
      );
      state.bridge?.close();
      state.bridgeServer?.close();
      await stopProjectProcess(state);
      state.watcher?.close();
      if (state.reloadTimer !== undefined) clearTimeout(state.reloadTimer);
      await state.browser.close();
      state.server?.close();
      jsonResponse(response, 200, { ok: true, value: state.status });
      setImmediate(() => process.exit(0));
      return;
    }
    if (url.pathname === '/capture') {
      if (state.evalRunning) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-eval-running',
            'Capture is blocked until the current evaluation completes.',
          ),
        });
        return;
      }
      const args = (await body(request)) as {
        readonly output?: unknown;
        readonly checkpoint?: unknown;
        readonly instance?: unknown;
        readonly instanceId?: unknown;
        readonly loadId?: unknown;
        readonly worldIdentity?: unknown;
      };
      if (!(await requireCurrentBridge(state, response))) return;
      await refreshFrameStatus(state);
      const before = state.status;
      const identityError = assertLiveIdentity(state, args);
      if (identityError !== undefined) {
        jsonResponse(response, 409, { ok: false, error: identityError });
        return;
      }
      if (state.session === undefined || before.phase !== 'ready') {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      // Fail before entering the 120s compositor wait when the project has no
      // renderable camera. Capture is an observation of the live World, so the
      // realm's structured camera error is the honest terminal result.
      try {
        await bridgeCall(state, 'return simulation.observation?.camera.get();', 5_000).promise;
      } catch (error) {
        const code =
          typeof (error as { readonly code?: unknown })?.code === 'string'
            ? (error as { readonly code: string }).code
            : 'live-camera-unavailable';
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            code,
            error instanceof Error ? error.message : 'The live World has no active camera.',
          ),
        });
        return;
      }
      const record = await state.session.capture(
        typeof args.checkpoint === 'string' ? args.checkpoint : undefined,
        {
          ...(typeof args.output === 'string' ? { output: args.output } : {}),
        },
      );
      if (!(await requireCurrentBridge(state, response))) return;
      await refreshFrameStatus(state);
      const after = state.status;
      if (
        before.instanceId !== after.instanceId ||
        before.loadId !== after.loadId ||
        before.worldIdentity !== after.worldIdentity
      ) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-instance-changed',
            'The live instance changed while capturing; retry against the new status.',
          ),
        });
        return;
      }
      jsonResponse(response, 200, {
        ok: true,
        value: {
          instanceId: after.instanceId,
          loadId: after.loadId,
          frameId: record.runtime.engineFrameId,
          record,
        },
      });
      return;
    }
    if (
      url.pathname === '/camera/get' ||
      url.pathname === '/camera/set' ||
      url.pathname === '/focus'
    ) {
      if (state.evalRunning) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-eval-running',
            'Observation mutation is blocked until the current evaluation completes.',
          ),
        });
        return;
      }
      if (state.session === undefined) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      const args = (await body(request)) as Record<string, unknown>;
      if (!(await requireCurrentBridge(state, response))) return;
      if (state.status.phase !== 'ready') {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      const identityError = assertLiveIdentity(state, args);
      if (identityError !== undefined) {
        jsonResponse(response, 409, { ok: false, error: identityError });
        return;
      }
      const before = state.status;
      const operation = url.pathname.slice(1) as InspectionRequest['operation'];
      const script =
        operation === 'camera/get'
          ? 'return simulation.observation?.camera.get();'
          : operation === 'camera/set'
            ? `return simulation.observation?.camera.set(${JSON.stringify(args)});`
            : `return simulation.observation?.focus(${JSON.stringify(args)});`;
      const result = await bridgeEval(state, script);
      if (operation !== 'camera/get') await waitForFrameAfter(state.session, before.frameId);
      if (!(await requireCurrentBridge(state, response))) return;
      await refreshFrameStatus(state);
      if (
        before.instanceId !== state.status.instanceId ||
        before.loadId !== state.status.loadId ||
        before.worldIdentity !== state.status.worldIdentity
      ) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-instance-changed',
            'The live instance or World changed while applying the camera operation; retry against the new status.',
          ),
        });
        return;
      }
      jsonResponse(response, 200, {
        ok: true,
        value: {
          instanceId: state.status.instanceId,
          loadId: state.status.loadId,
          frameId: state.status.frameId,
          result,
        },
      });
      return;
    }
    if (url.pathname === '/eval') {
      const args = (await body(request)) as {
        readonly code?: unknown;
        readonly timeoutMs?: unknown;
        readonly instance?: unknown;
        readonly instanceId?: unknown;
        readonly loadId?: unknown;
        readonly worldIdentity?: unknown;
      };
      if (typeof args.code !== 'string' || args.code.trim().length === 0) {
        jsonResponse(response, 400, {
          ok: false,
          error: commandError(
            'live-invalid-eval',
            'Provide a non-empty JavaScript expression in code.',
          ),
        });
        return;
      }
      if (state.evalRunning) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-eval-running',
            'Only status, reload, and stop are available while eval is running.',
          ),
        });
        return;
      }
      if (state.session === undefined) {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      if (!(await requireCurrentBridge(state, response))) return;
      if (state.status.phase !== 'ready') {
        jsonResponse(response, 409, {
          ok: false,
          error: commandError(
            'live-not-ready',
            'Wait for the live instance to reach a submitted frame.',
          ),
        });
        return;
      }
      const before = state.status;
      const identityError = assertLiveIdentity(state, args);
      if (identityError !== undefined) {
        jsonResponse(response, 409, { ok: false, error: identityError });
        return;
      }
      state.evalRunning = true;
      evalIdentity = { instanceId: before.instanceId, loadId: before.loadId };
      state.status = { ...state.status, unfinishedEval: true };
      await writeSessionFile(state);
      const timeout = typeof args.timeoutMs === 'number' ? Math.max(0, args.timeoutMs) : 30_000;
      // The caller timeout only bounds the HTTP wait. The bridge request stays
      // pending until the actual realm returns or a hard reload/stop closes it.
      const evaluationCall = bridgeCall(state, args.code, null);
      const evaluation = evaluationCall.promise;
      const timed = await Promise.race([
        evaluation.then((value) => ({ state: 'completed' as const, value })),
        new Promise<{ state: 'continuing' }>((resolveTimeout) =>
          setTimeout(() => resolveTimeout({ state: 'continuing' }), timeout),
        ),
      ]);
      if (timed.state === 'continuing') {
        if (!evaluationCall.started()) {
          const admitted = await Promise.race([
            evaluationCall.cancel(),
            new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 2_000)),
          ]);
          void evaluation.catch(() => {});
          if (!admitted) {
            state.evalRunning = false;
            evalIdentity = undefined;
            state.status = { ...state.status, unfinishedEval: false };
            await writeSessionFile(state);
            jsonResponse(response, 409, {
              ok: false,
              error: commandError(
                'live-eval-cancelled-before-execution',
                'The evaluation did not start before the caller deadline and was cancelled.',
                { continuing: false, instanceId: before.instanceId, loadId: before.loadId },
              ),
            });
            return;
          }
        }
        jsonResponse(response, 408, {
          ok: false,
          error: commandError(
            'live-eval-continuing',
            'The caller wait ended; the owner still tracks the evaluation.',
            { continuing: true, instanceId: before.instanceId, loadId: before.loadId },
          ),
        });
        void evaluation.then(
          () => {
            if (
              state.status.instanceId !== before.instanceId ||
              state.status.loadId !== before.loadId
            )
              return;
            state.evalRunning = false;
            state.status = { ...state.status, unfinishedEval: false };
            void writeSessionFile(state);
          },
          () => {
            if (
              state.status.instanceId !== before.instanceId ||
              state.status.loadId !== before.loadId
            )
              return;
            state.evalRunning = false;
            state.status = { ...state.status, unfinishedEval: false };
            void writeSessionFile(state);
          },
        );
        return;
      }
      state.evalRunning = false;
      evalIdentity = undefined;
      state.status = { ...state.status, unfinishedEval: false };
      if (!(await requireCurrentBridge(state, response))) return;
      await writeSessionFile(state);
      jsonResponse(response, 200, {
        ok: true,
        value: { instanceId: before.instanceId, loadId: before.loadId, result: timed.value },
      });
      return;
    }
    jsonResponse(response, 404, {
      ok: false,
      error: commandError('live-route-not-found', 'Use status, reload, stop, eval, or capture.'),
    });
  } catch (error) {
    if (
      evalIdentity !== undefined &&
      state.status.instanceId === evalIdentity.instanceId &&
      state.status.loadId === evalIdentity.loadId
    ) {
      state.evalRunning = false;
      state.status = { ...state.status, unfinishedEval: false };
      void writeSessionFile(state);
    }
    jsonResponse(response, 500, {
      ok: false,
      error: commandError(
        'live-operation-failed',
        error instanceof Error ? error.message : String(error),
      ),
    });
  }
}

export async function runLiveDevDaemon(
  rootInput: string,
  port: number,
  sessionFile = sessionPath(rootInput),
): Promise<void> {
  const root = resolve(rootInput);
  const state: LiveDevDaemonState = {
    root,
    sessionPath: sessionFile,
    browser: createBrowserCapture(root),
    backend:
      process.env.FORGEAX_DEV_BACKEND === 'hardware' ||
      process.env.FORGEAX_DEV_BACKEND === 'software'
        ? process.env.FORGEAX_DEV_BACKEND
        : 'auto',
    requestedExecutionTier:
      process.env.FORGEAX_DEV_EXECUTION === 'engine-worker' ? 'engine-worker' : 'main-serial',
    session: undefined,
    projectUrl: undefined,
    status: {
      schemaVersion: '1.0.0',
      root,
      endpoint: `http://127.0.0.1:${port}`,
      pid: process.pid,
      generation: 0,
      instanceId: randomUUID(),
      loadId: randomUUID(),
      phase: 'starting',
      unfinishedEval: false,
      url: undefined,
      frameId: undefined,
      worldIdentity: undefined,
      executionTier: undefined,
      backend:
        process.env.FORGEAX_DEV_BACKEND === 'hardware' ||
        process.env.FORGEAX_DEV_BACKEND === 'software'
          ? process.env.FORGEAX_DEV_BACKEND
          : 'auto',
      bridgeConnected: false,
      error: undefined,
    },
    evalRunning: false,
    server: undefined,
    bridgeServer: undefined,
    bridge: undefined,
    bridgeNextId: 1,
    bridgePending: new Map(),
    projectProcess: undefined,
    watcher: undefined,
    reloadTimer: undefined,
    reloadInFlight: undefined,
    reloadRequested: false,
  };
  state.server = createServer((request, response) => void handleRequest(state, request, response));
  installBridgeRelay(state);
  await new Promise<void>((resolveListen, rejectListen) => {
    state.server?.once('error', rejectListen);
    state.server?.listen(port, '127.0.0.1', resolveListen);
  });
  await writeSessionFile(state);
  watchProjectInputs(state);
  await openSession(state);
  await new Promise<void>((resolveClose) => state.server?.once('close', resolveClose));
}

async function readSession(root: string): Promise<LiveDevSessionFile> {
  return JSON.parse(await readFile(sessionPath(root), 'utf8')) as LiveDevSessionFile;
}

async function requestJson(
  session: LiveDevSessionFile,
  path: string,
  method: 'GET' | 'POST',
  value?: unknown,
): Promise<unknown> {
  return new Promise((resolveResponse, rejectResponse) => {
    const request = httpRequest(
      `${session.endpoint}${path}`,
      { method, headers: { 'content-type': 'application/json' } },
      (response) => {
        let raw = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => (raw += chunk));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(raw) as unknown;
            resolveResponse(parsed);
          } catch (error) {
            rejectResponse(error);
          }
        });
      },
    );
    request.on('error', rejectResponse);
    if (value !== undefined) request.write(JSON.stringify(value));
    request.end();
  });
}

export async function liveDevStatus(rootInput: string): Promise<unknown> {
  const root = resolve(rootInput);
  const session = await readSession(root);
  return requestJson(session, '/status', 'GET');
}

export async function liveDevControl(
  rootInput: string,
  operation: Exclude<LiveOperation, 'status'>,
  value?: unknown,
): Promise<unknown> {
  const root = resolve(rootInput);
  const session = await readSession(root);
  return requestJson(session, `/${operation}`, 'POST', value);
}

export async function startLiveDev(
  rootInput: string,
  options: {
    readonly headless?: boolean;
    readonly backend?: LiveDevBackend;
    readonly tier?: LiveDevExecutionTier;
  } = {},
): Promise<unknown> {
  const root = resolve(rootInput);
  try {
    const existing = await liveDevStatus(root);
    if (
      existing !== null &&
      typeof existing === 'object' &&
      'value' in existing &&
      existing.value !== null &&
      typeof existing.value === 'object' &&
      'phase' in existing.value &&
      existing.value.phase !== 'stopped' &&
      existing.value.phase !== 'failed' &&
      existing.value.phase !== 'starting' &&
      existing.value.phase !== 'reloading'
    ) {
      return existing;
    }
  } catch {
    // A stale or missing session is replaced below.
  }
  const port = await new Promise<number>((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const selected = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolvePort(selected));
    });
  });
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('live DevKit service requires a CLI entrypoint');
  const child = spawn(process.execPath, [entry, '--__forgeax-live-daemon', root, String(port)], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      ...(options.headless === undefined ? {} : { FORGEAX_DEV_HEADLESS: String(options.headless) }),
      ...(options.backend === undefined ? {} : { FORGEAX_DEV_BACKEND: options.backend }),
      ...(options.tier === undefined ? {} : { FORGEAX_DEV_EXECUTION: options.tier }),
    },
  });
  child.unref();
  const file = sessionPath(root);
  // Building the project child and opening the controlled Page are bounded by
  // the same startup path as an ordinary `project preview`; a cold SDK tree
  // can take longer than the old ten second polling window. Keep the daemon
  // detached while the caller waits for its terminal starting state.
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      await access(file);
      const status = await liveDevStatus(root);
      if (
        status !== null &&
        typeof status === 'object' &&
        'value' in status &&
        status.value !== null &&
        typeof status.value === 'object' &&
        'phase' in status.value &&
        status.value.phase !== 'starting' &&
        status.value.phase !== 'reloading'
      ) {
        return status;
      }
    } catch {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error('live DevKit service did not publish a session endpoint');
}

export async function removeLiveDevSession(rootInput: string): Promise<void> {
  try {
    await unlink(sessionPath(resolve(rootInput)));
  } catch {
    // The service owns the session file and may remove it during shutdown.
  }
}
