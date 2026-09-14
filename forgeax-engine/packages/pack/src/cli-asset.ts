#!/usr/bin/env node

// @forgeax/engine-pack/src/cli-asset — Pack producer implementation used by
// DevKit's unified `forgeax asset` command. It is not a package bin.
//
// stderr contract (plan-strategy section 2.3 weak-contract): every error
// path emits a single JSON Lines record carrying `code` / `expected` /
// `hint`; `detail` is included when the underlying error supplied one.
// Exit codes: 0 success, 1 any error.

import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { ArtifactDescriptor, AssetEvidence, CookReceipt } from '@forgeax/engine-types';
import { validateArtifactPath } from './artifact-path.js';
import { runAtlas } from './atlas/run-atlas.js';
import {
  buildOfflineAssetEvidence,
  type OfflineArtifactInput,
} from './evidence/offline-evidence.js';
import { readSourceInventory } from './evidence/source-inventory.js';
import { isValidAssetGuidString } from './guid.js';
import { parsePackV2 } from './index.js';
import { projectScriptablePackMeta } from './pack-authoring.js';
import { type ScanSourceDeclaration, scanInventory } from './scanner.js';
import { loadScriptablePack } from './scriptable-pack-node.js';

// The unified DevKit command tree reuses the producer implementation without
// reviving the historical standalone executable as a second public surface.
export { runAtlas } from './atlas/run-atlas.js';

export interface PackEntry {
  readonly guid: string;
  readonly kind: string;
  readonly sourcePath: string;
  readonly name?: string;
}

interface AssetCtx {
  readonly stdoutWrite: (line: string) => void;
  readonly stderrWrite: (line: string) => void;
  /** Optional cwd override (defaults to `process.cwd()`); enables hermetic tests. */
  readonly cwd?: string;
}

interface ScanErrShape {
  code: string;
  expected: string;
  hint: string;
  detail?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function emitError(ctx: AssetCtx, err: ScanErrShape): number {
  const payload: Record<string, unknown> = {
    code: err.code,
    expected: err.expected,
    hint: err.hint,
  };
  if (err.detail !== undefined) payload.detail = err.detail;
  ctx.stderrWrite(JSON.stringify(payload));
  return 1;
}

export async function scanEntries(
  roots: readonly string[],
  ctx: AssetCtx,
): Promise<{ ok: true; value: PackEntry[] } | { ok: false }> {
  const result = await scanInventory(roots);
  if (!result.ok) {
    emitError(ctx, {
      code: result.error.code,
      expected: result.error.expected,
      hint: result.error.hint,
      detail: result.error.detail,
    });
    return { ok: false };
  }
  const entries: PackEntry[] = [];
  // The scanner is the single identity projection for Pack JSON. ScriptablePack
  // source modules deliberately contribute no rows until a build generation.
  for (const declaration of result.value.declarations.values()) {
    if (declaration.format !== 'meta.json') continue;
    const sourcePath = declaration.sourcePath;
    const assets = declaration.value.subAssets;
    for (const asset of assets) {
      if (!isRecord(asset) || typeof asset.guid !== 'string' || typeof asset.kind !== 'string') {
        continue;
      }
      const name =
        typeof asset.name === 'string'
          ? asset.name
          : typeof asset.sourceKey === 'string'
            ? asset.sourceKey
            : undefined;
      entries.push({
        guid: asset.guid,
        kind: asset.kind,
        sourcePath,
        ...(name === undefined ? {} : { name }),
      });
    }
  }
  const names = new Map<string, string>();
  for (const declaration of result.value.declarations.values()) {
    if (declaration.format !== 'pack.json') continue;
    if (declaration.value.schemaVersion === '3.0.0') {
      for (const [sourceKey, asset] of Object.entries(declaration.value.assets ?? {})) {
        if (isRecord(asset) && typeof asset.name === 'string') {
          names.set(`${declaration.sourcePath}:${sourceKey}`, asset.name);
        }
      }
      continue;
    }
    for (const asset of declaration.value.assets) {
      if (typeof asset.name === 'string') {
        names.set(`${declaration.sourcePath}:${asset.guid.toLowerCase()}`, asset.name);
      }
    }
  }
  for (const inventoryEntry of result.value.inventory) {
    const declaration = result.value.declarations.get(inventoryEntry.sourcePath) as
      | ScanSourceDeclaration
      | undefined;
    const namedByKey =
      inventoryEntry.sourceKey === undefined
        ? names.get(`${inventoryEntry.sourcePath}:${inventoryEntry.guid.toLowerCase()}`)
        : names.get(`${inventoryEntry.sourcePath}:${inventoryEntry.sourceKey}`);
    const name =
      namedByKey ?? names.get(`${inventoryEntry.sourcePath}:${inventoryEntry.guid.toLowerCase()}`);
    entries.push({
      guid: inventoryEntry.guid,
      kind: inventoryEntry.kind,
      sourcePath: inventoryEntry.sourcePath,
      ...(name === undefined ? {} : { name }),
      ...(declaration?.format === 'pack.json' &&
      declaration.value.schemaVersion === '3.0.0' &&
      inventoryEntry.sourceKey !== undefined &&
      name === undefined
        ? { name: inventoryEntry.sourceKey }
        : {}),
    });
  }
  entries.sort((left, right) =>
    `${left.sourcePath}:${left.guid}`.localeCompare(`${right.sourcePath}:${right.guid}`),
  );
  return { ok: true, value: entries };
}

function helpBody(): string {
  return [
    'forgeax asset — offline pack scanner / lookup / verifier / atlas builder',
    '',
    'Usage:',
    '  forgeax asset list --root <project> --json',
    '  forgeax asset inspect --subject <guid> --root <project> --json',
    '  forgeax asset verify --root <project> --json',
    '  forgeax asset inspect --subject <source.pack.ts> --root <project> --json',
    '  forgeax asset atlas --input <glob> --name <prefix> --root <project> [--output <dir>]',
    '',
    'AI recovery commands (host execution remains explicit):',
    '  inspect [--guid <guid>]      read subject, execution, lifecycle, authority, and sourceKey evidence',
    '  rebuild [--guid <guid>]     request the declared producer to rebuild',
    '  cold-cook [--guid <guid>]   discard invalid DDC output and cook from author authority',
    '  preview-LKG [--guid <guid>] read the explicit last-known-good projection',
    '  override [--guid <guid>]    request an Editor-owned override through its gateway',
    '  promote [--guid <guid>]     request an authored Pack from an imported result',
    '  stop-publish [--guid <guid>] block publication while evidence is incomplete',
    '',
  ].join('\n');
}

export async function runCliAsset(rest: string[], ctx: AssetCtx): Promise<number> {
  const [sub, ...subRest] = rest;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    ctx.stdoutWrite(helpBody());
    return 0;
  }
  switch (sub) {
    case 'scan':
      return runScan(subRest, ctx);
    case 'lookup':
      return runLookup(subRest, ctx);
    case 'verify':
      return runVerify(subRest, ctx);
    case 'atlas':
      return runAtlas(subRest, ctx);
    case 'meta':
      return runMeta(subRest, ctx);
    case 'inspect':
    case 'rebuild':
    case 'cold-cook':
    case 'preview-LKG':
    case 'override':
    case 'promote':
    case 'stop-publish':
      return runRecoveryCommand(sub, subRest, ctx);
    default:
      return emitError(ctx, {
        code: 'unknown-subcommand',
        expected: 'subcommand in {scan, lookup, verify, atlas, meta}',
        hint: "run 'forgeax help asset' for usage",
        detail: { subcommand: sub },
      });
  }
}

async function runMeta(rest: string[], ctx: AssetCtx): Promise<number> {
  let source: string | undefined;
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: true,
      strict: true,
      options: { json: { type: 'boolean' } },
    });
    source = parsed.positionals[0];
    if (source === undefined || parsed.positionals.length !== 1) {
      throw new Error('exactly one ScriptablePack source path is required');
    }
  } catch (error) {
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax asset inspect --subject <source.pack.ts> --root <project> --json',
      hint: 'pass one trusted ScriptablePack module path',
      detail: { message: error instanceof Error ? error.message : String(error) },
    });
  }
  const cwd = ctx.cwd ?? process.cwd();
  const loaded = await loadScriptablePack(absolutePath(source, cwd), {
    metadataOnly: true,
  });
  if (!loaded.ok) return emitError(ctx, loaded.error);
  ctx.stdoutWrite(JSON.stringify(projectScriptablePackMeta(loaded.value, source)));
  return 0;
}

/** Emit a canonical host-operation request so recovery actions are executable
 * from one CLI door even when the actual write/cook owner is the running host. */
async function runRecoveryCommand(
  operation:
    | 'inspect'
    | 'rebuild'
    | 'cold-cook'
    | 'preview-LKG'
    | 'override'
    | 'promote'
    | 'stop-publish',
  rest: string[],
  ctx: AssetCtx,
): Promise<number> {
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: { guid: { type: 'string' } },
    });
    const guid = parsed.values.guid;
    ctx.stdoutWrite(
      JSON.stringify({
        operation,
        status: 'accepted',
        execution: 'host-gateway',
        ...(typeof guid === 'string' ? { guid } : {}),
        hint: 'forward this operation descriptor to the running Editor/Studio gateway for its terminal result',
      }),
    );
    return 0;
  } catch (error) {
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: `${operation} [--guid <guid>]`,
      hint: "run 'forgeax help asset' for usage",
      detail: { message: error instanceof Error ? error.message : String(error) },
    });
  }
}

async function runScan(rest: string[], ctx: AssetCtx): Promise<number> {
  let roots: string[];
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: { roots: { type: 'string', multiple: true } },
    });
    roots = (parsed.values.roots as string[] | undefined) ?? [ctx.cwd ?? process.cwd()];
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax asset list --root <project> --json',
      hint: "run 'forgeax help asset' for usage",
      detail: { message },
    });
  }
  const result = await scanEntries(roots, ctx);
  if (!result.ok) return 1;
  ctx.stdoutWrite(JSON.stringify(result.value));
  return 0;
}

async function runLookup(rest: string[], ctx: AssetCtx): Promise<number> {
  if (rest.some((value) => value === '--guid')) return runEvidence(rest, ctx);
  const [guid] = rest;
  if (typeof guid !== 'string') {
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax asset inspect --subject <guid> --root <project> --json',
      hint: 'pass a 36-char dash-form UUID positional argument',
    });
  }
  if (!isValidAssetGuidString(guid)) {
    return emitError(ctx, {
      code: 'pack-guid-malformed',
      expected: '36-char RFC 4122 dash-form GUID (8-4-4-4-12 lowercase hex)',
      hint: 'use AssetGuid.random() or a UUIDv7 generator; all GUID fields must be 36-char RFC 4122 dash-form',
      detail: { raw: guid, reason: 'invalid-format' },
    });
  }
  const cwd = ctx.cwd ?? process.cwd();
  const result = await scanEntries([cwd], ctx);
  if (!result.ok) return 1;
  const normalized = guid.toLowerCase();
  const entry = result.value.find((e) => e.guid.toLowerCase() === normalized);
  if (entry === undefined) {
    return emitError(ctx, {
      code: 'asset-not-found',
      expected: 'GUID present in scan results',
      hint: 'run scan to list known GUIDs; verify the GUID came from a .meta.json sub-asset entry',
      detail: { guid: normalized },
    });
  }
  ctx.stdoutWrite(JSON.stringify(entry));
  return 0;
}

async function runVerify(rest: string[], ctx: AssetCtx): Promise<number> {
  if (rest.some((value) => value === '--guid')) return runEvidence(rest, ctx);
  try {
    parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {},
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return emitError(ctx, {
      code: 'cli-parse-error',
      expected: 'forgeax asset verify --root <project> --json',
      hint: "run 'forgeax help asset' for usage",
      detail: { message },
    });
  }
  const cwd = ctx.cwd ?? process.cwd();
  const result = await scanEntries([cwd], ctx);
  if (!result.ok) return 1;

  const materialCount = result.value.filter((e) => e.kind === 'material').length;
  ctx.stdoutWrite(`material-validated: ${materialCount}`);
  return 0;
}

interface EvidenceCliOptions {
  readonly guid: string;
  readonly project: string;
  readonly catalog: string;
}

/** Parse the machine-oriented evidence probe flags shared by lookup and verify. */
function parseEvidenceOptions(rest: string[], ctx: AssetCtx): EvidenceCliOptions | undefined {
  try {
    const parsed = parseArgs({
      args: rest,
      allowPositionals: false,
      strict: true,
      options: {
        guid: { type: 'string' },
        project: { type: 'string' },
        catalog: { type: 'string' },
        json: { type: 'boolean' },
      },
    });
    const guid = parsed.values.guid;
    const project = parsed.values.project;
    const catalog = parsed.values.catalog;
    if (typeof guid !== 'string' || typeof project !== 'string' || typeof catalog !== 'string') {
      emitError(ctx, {
        code: 'cli-parse-error',
        expected: '--guid <guid> --project <dir> --catalog <path> --json',
        hint: "run 'forgeax help asset' for usage",
      });
      return undefined;
    }
    return { guid, project, catalog };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    emitError(ctx, {
      code: 'cli-parse-error',
      expected: '--guid <guid> --project <dir> --catalog <path> --json',
      hint: "run 'forgeax help asset' for usage",
      detail: { message },
    });
    return undefined;
  }
}

function absolutePath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

async function readJson(path: string, ctx: AssetCtx): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (e) {
    emitError(ctx, {
      code: 'asset-evidence-input-invalid',
      expected: `readable JSON evidence input at ${path}`,
      hint: 'restore the catalog or cook receipt JSON, then rerun lookup or verify',
      detail: { path, message: e instanceof Error ? e.message : String(e) },
    });
    return undefined;
  }
}

function catalogRows(value: unknown): readonly Record<string, unknown>[] | undefined {
  if (Array.isArray(value)) return value.filter(isRecord);
  if (!isRecord(value) || !Array.isArray(value.entries)) return undefined;
  return value.entries.filter(isRecord);
}

function packagePath(projectRoot: string, packageUrl: string): string {
  const relative = packageUrl.replace(/^\/+/, '');
  return resolve(projectRoot, relative);
}

function artifactInputs(
  pack: { readonly guid: string; readonly artifacts: Readonly<Record<string, ArtifactDescriptor>> },
  packagePathValue: string,
): Promise<Readonly<Record<string, OfflineArtifactInput>>> {
  return Promise.all(
    Object.entries(pack.artifacts).map(async ([key, descriptor]) => {
      const pathResult = validateArtifactPath(descriptor.path, {
        packageRoot: dirname(packagePathValue),
        guid: pack.guid,
        artifactKey: key,
      });
      if (!pathResult.ok) return [key, { ...descriptor, verification: 'failed' as const }] as const;
      const artifactPath = resolve(dirname(packagePathValue), pathResult.value);
      try {
        const bytes = await readFile(artifactPath);
        const lengthOk =
          descriptor.byteLength === undefined || descriptor.byteLength === bytes.byteLength;
        const digestOk =
          descriptor.integrity === undefined ||
          createHash('sha256').update(bytes).digest('base64') === descriptor.integrity.digest;
        return [
          key,
          {
            ...descriptor,
            verification: lengthOk && digestOk ? ('passed' as const) : ('failed' as const),
          },
        ] as const;
      } catch {
        return [key, { ...descriptor, verification: 'failed' as const }] as const;
      }
    }),
  ).then((entries) => Object.fromEntries(entries));
}

/** Join offline source, catalog, receipt, and Pack v2 facts into one JSON result. */
async function runEvidence(rest: string[], ctx: AssetCtx): Promise<number> {
  const options = parseEvidenceOptions(rest, ctx);
  if (options === undefined) return 1;
  if (!isValidAssetGuidString(options.guid)) {
    return emitError(ctx, {
      code: 'pack-guid-malformed',
      expected: '36-char RFC 4122 dash-form GUID (8-4-4-4-12 lowercase hex)',
      hint: 'use AssetGuid.random() or a UUIDv7 generator; all GUID fields must be 36-char RFC 4122 dash-form',
      detail: { raw: options.guid, reason: 'invalid-format' },
    });
  }
  const projectRoot = absolutePath(options.project, ctx.cwd ?? process.cwd());
  const catalogValue = await readJson(absolutePath(options.catalog, ctx.cwd ?? process.cwd()), ctx);
  if (catalogValue === undefined) return 1;
  const rows = catalogRows(catalogValue);
  if (rows === undefined) {
    return emitError(ctx, {
      code: 'asset-evidence-input-invalid',
      expected: 'catalog JSON array or {entries: []} object',
      hint: 'rebuild the catalog and rerun lookup or verify',
      detail: { path: options.catalog },
    });
  }
  const row = rows.find(
    (candidate) => candidate.guid?.toString().toLowerCase() === options.guid.toLowerCase(),
  );
  if (row === undefined || typeof row.packageUrl !== 'string') {
    return emitError(ctx, {
      code: 'asset-not-found',
      expected: 'catalog row with GUID and packageUrl',
      hint: 'rebuild the catalog or verify the GUID came from the project source inventory',
      detail: { guid: options.guid },
    });
  }
  const packageUrl = row.packageUrl;
  const packageFile = packagePath(projectRoot, packageUrl);
  const packageValue = await readJson(packageFile, ctx);
  if (packageValue === undefined) return 1;
  const parsedPack = parsePackV2(packageValue);
  if (!parsedPack.ok) return emitError(ctx, parsedPack.error);
  const asset = parsedPack.value.assets.find(
    (candidate) => candidate.guid.toLowerCase() === options.guid.toLowerCase(),
  );
  if (asset === undefined) {
    return emitError(ctx, {
      code: 'asset-evidence-input-invalid',
      expected: 'Pack v2 package asset with the requested GUID',
      hint: 'recook the package and rebuild the catalog so the GUID and package agree',
      detail: { guid: options.guid, packageUrl },
    });
  }
  const source = await readSourceInventory({ projectRoot, guid: options.guid });
  const receipt =
    typeof row.cookReceiptUrl === 'string'
      ? await readJson(packagePath(projectRoot, row.cookReceiptUrl), ctx)
      : undefined;
  if (row.cookReceiptUrl !== undefined && receipt === undefined) return 1;
  const packageArtifacts = await artifactInputs(asset, packageFile);
  const result = await buildOfflineAssetEvidence({
    guid: options.guid,
    ...(source === undefined ? {} : { source }),
    locator: {
      packageUrl,
      ...(typeof row.cookReceiptUrl === 'string' ? { cookReceiptUrl: row.cookReceiptUrl } : {}),
    },
    ...(receipt !== undefined ? { receipt: receipt as CookReceipt } : {}),
    package: { guid: asset.guid, artifacts: packageArtifacts },
  });
  if (!result.ok) return emitError(ctx, result.error);
  ctx.stdoutWrite(JSON.stringify(result.value satisfies AssetEvidence));
  return 0;
}

// Bin entry guard — only fires when this module is the process entry.
const isBinEntry = await (async (): Promise<boolean> => {
  const argv1 = process.argv[1];
  if (typeof argv1 !== 'string') return false;
  const argv1Real = await realpath(argv1).catch(() => argv1);
  const selfReal = await realpath(fileURLToPath(import.meta.url)).catch(() =>
    fileURLToPath(import.meta.url),
  );
  return argv1Real === selfReal;
})();

if (isBinEntry) {
  const exitCode = await runCliAsset(process.argv.slice(2), {
    stdoutWrite: (line: string) => process.stdout.write(`${line}\n`),
    stderrWrite: (line: string) => process.stderr.write(`${line}\n`),
  });
  process.exit(exitCode);
}
