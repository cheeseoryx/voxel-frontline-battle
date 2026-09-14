import type { GameProjectPluginEntry } from '@forgeax/engine-project';

export interface CommandError {
  readonly code: string;
  readonly expected: string;
  readonly hint: string;
  readonly detail: Readonly<Record<string, unknown>>;
}

export type CommandResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: CommandError };

export interface ProjectFacts {
  readonly root: string;
  readonly id: string;
  readonly name: string;
  readonly plugins: readonly GameProjectPluginEntry[];
  readonly defaultScene?: string;
  readonly assetRoots: readonly string[];
  readonly packageJson: Readonly<Record<string, unknown>>;
}

export interface ProjectCommandOptions {
  readonly root?: string;
  readonly json?: boolean;
  readonly port?: number;
}

export interface ProjectPortOptions {
  readonly port: number;
  readonly strictPort: boolean;
}

export function parseProjectPortOption(
  value: string | undefined,
  provided: boolean,
): CommandResult<number | undefined> {
  if (!provided) return { ok: true, value: undefined };
  if (value !== undefined && /^(0|[1-9]\d*)$/.test(value)) {
    const port = Number(value);
    if (Number.isSafeInteger(port) && port <= 65_535) return { ok: true, value: port };
  }
  return {
    ok: false,
    error: {
      code: 'cli-parse-error',
      expected: '--port to be 0 or an integer from 1 to 65535',
      hint: 'Omit --port for strict 5173, pass a positive port for a strict binding, or pass 0 for an OS-assigned port.',
      detail: { option: '--port', received: value ?? null },
    },
  };
}

export function resolveProjectPort(port: number | undefined): ProjectPortOptions {
  return { port: port ?? 5173, strictPort: port !== 0 };
}

export interface InitOptions extends ProjectCommandOptions {
  readonly dryRun?: boolean;
  readonly install?: boolean;
}

export interface NewOptions extends ProjectCommandOptions {
  readonly dryRun?: boolean;
  readonly template?: string;
  /** Override the generated project id; defaults to the target directory basename. */
  readonly id?: string;
  /** Override the generated display name; defaults to the generated id. */
  readonly name?: string;
  /** Override the generated npm package name; defaults to the template namespace plus id. */
  readonly packageName?: string;
}

export interface BuildOptions extends ProjectCommandOptions {
  readonly base?: string;
  readonly outDir?: string;
}

export interface PackageOptions extends ProjectCommandOptions {
  readonly output?: string;
  readonly format?: PackageFormat;
}

export type PackageFormat = 'web-zip' | 'single-html';

export type CaptureBackend = 'auto' | 'software' | 'hardware';

export interface BrowserCaptureOptions extends ProjectCommandOptions {
  /** Prefer a rendering lane, or let the browser choose and report it. */
  readonly backend?: CaptureBackend;
  /** Backwards-compatible alias for `backend: 'software'`. */
  readonly software?: boolean;
  readonly output?: string;
  readonly browser?: string;
  readonly width?: number;
  readonly height?: number;
  readonly waitMs?: number;
  readonly requireUi?: boolean;
  readonly deterministic?: boolean;
  readonly headless?: boolean;
}

/** @deprecated Use BrowserCaptureOptions with `backend: 'software'`. */
export interface SoftwareCaptureOptions extends BrowserCaptureOptions {
  readonly software: true;
  readonly backend?: 'software';
}

export interface AssetAddOptions extends ProjectCommandOptions {
  readonly path: string;
  readonly dryRun?: boolean;
}

export interface AssetInspectOptions extends ProjectCommandOptions {
  readonly subject: string;
}

export interface AssetResolveOptions extends ProjectCommandOptions {
  readonly subject?: string;
  readonly packageId?: string;
  readonly sourceKey?: string;
  readonly require?: 'identity' | 'present' | 'ready';
  readonly requestId?: string;
}

export interface ShaderCheckOptions extends ProjectCommandOptions {
  readonly path?: string;
}

export interface PluginInstallOptions extends ProjectCommandOptions {
  readonly id: string;
  readonly module: string;
  readonly realm?: 'host' | 'engine' | 'build';
  readonly dependency?: string;
  readonly dryRun?: boolean;
}

export interface PluginInspectOptions extends ProjectCommandOptions {
  readonly id?: string;
}

export interface PluginConfigureOptions extends ProjectCommandOptions {
  readonly id: string;
  readonly config: unknown;
  readonly dryRun?: boolean;
}

export interface PluginToggleOptions extends ProjectCommandOptions {
  readonly id: string;
  readonly dryRun?: boolean;
}

export interface PluginUninstallOptions extends ProjectCommandOptions {
  readonly id: string;
  readonly dependency?: string;
  readonly dryRun?: boolean;
}
