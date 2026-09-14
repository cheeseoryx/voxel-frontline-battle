import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { AssetGuid as EngineAssetGuid, Result } from '@forgeax/engine-types';
import { err, ok } from '@forgeax/engine-types';
import { AssetGuid, isValidAssetGuidString, isValidPackSourceKey, PackageId } from './guid.js';
import {
  type AnyScriptablePackDefinition,
  createPackAuthoringGateway,
  type DirectPackJsonAsset,
  type PackAuthoringError,
  type PackAuthoringErrorCode,
  type PackAuthoringGatewayPort,
  type PackAuthoringOperation,
  type PackAuthoringOperationResult,
  type PackAuthoringResolutionStatus,
  type PackParameterDefinition,
  type PackParameterInheritanceSubject,
  parsePackSourceJson,
  projectDirectPackJson,
  type ResolvedPackParameterInheritance,
  resolvePackParameterInheritance,
  validatePackDefinition,
} from './pack-authoring.js';
import { type ScanInventory, scanInventory } from './scanner.js';

export interface PackAuthoringMaterializedAsset {
  readonly packageId: string;
  readonly sourceKey: string;
  readonly guid: string;
  readonly kind: string;
  readonly sourcePath?: string;
  readonly refs?: readonly string[];
  readonly ready?: boolean;
  readonly artifactsReady?: boolean;
}

export interface FileSystemPackAuthoringOptions {
  readonly gameRoot: string;
  readonly scanRoots?: readonly string[];
  /** Current-generation rows only; this callback is never called by mutations. */
  readonly materialized?: () =>
    | readonly PackAuthoringMaterializedAsset[]
    | Promise<readonly PackAuthoringMaterializedAsset[]>;
  /** Build owner callback; the gateway itself does not own DDC or Catalog state. */
  readonly rebuild?: (
    sourcePath: string,
    mode: 'rebuild' | 'cold-cook',
  ) => Promise<Result<unknown, PackAuthoringError>>;
  /** Injection point for hosts that already own a validated Source Index. */
  readonly inventory?: () => Promise<Result<ScanInventory, unknown>>;
}

interface ConfinedPath {
  readonly absolute: string;
  readonly relative: string;
}

interface ProjectedDirectAsset extends DirectPackJsonAsset {
  readonly guid: string;
  readonly sourceKey: string;
}

interface SubjectBase {
  readonly packageId: PackageId;
  readonly sourcePath: string;
  readonly relativePath: string;
}

interface SourceSubject extends SubjectBase {
  readonly format: 'source';
  readonly definition: AnyScriptablePackDefinition;
}

interface DirectSubject extends SubjectBase {
  readonly format: 'direct';
  readonly assets: readonly ProjectedDirectAsset[];
}

interface InstanceSubject extends SubjectBase {
  readonly format: 'instance';
  readonly parent: PackageId;
  readonly values: Readonly<Record<string, unknown>>;
}

type Subject = SourceSubject | DirectSubject | InstanceSubject;

interface MaterializedAsset {
  readonly packageId: string;
  readonly sourceKey: string;
  readonly guid: string;
  readonly kind: string;
  readonly sourcePath?: string;
  readonly name?: string;
  readonly refs?: readonly string[];
  readonly ready: boolean;
}

type DirectAuthorAsset = Omit<MaterializedAsset, 'ready'>;

interface GatewaySnapshot {
  readonly inventory: ScanInventory;
  readonly subjects: ReadonlyMap<string, Subject>;
  readonly directAssets: readonly DirectAuthorAsset[];
  readonly materialized: readonly MaterializedAsset[];
  readonly knownGuids: ReadonlySet<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return AssetGuid.format(value as EngineAssetGuid);
  if (Array.isArray(value)) return value.map((item) => jsonValue(item));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  }
  return value;
}

function revisionOf(source: string): string {
  return `sha256:${createHash('sha256').update(source).digest('hex')}`;
}

function makeError(
  code: PackAuthoringErrorCode,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
  actual?: string,
): PackAuthoringError {
  return {
    code,
    expected,
    hint,
    ...(actual === undefined ? {} : { actual }),
    detail,
  };
}

function pathError(
  code:
    | 'pack-source-path-invalid'
    | 'pack-source-not-found'
    | 'pack-source-write-failed'
    | 'pack-source-revision-conflict',
  operation: PackAuthoringOperation,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
  actual?: string,
): PackAuthoringError {
  return makeError(code, expected, hint, { requestId: operation.requestId, ...detail }, actual);
}

function confinedPath(
  gameRoot: string,
  candidate: unknown,
  operation: PackAuthoringOperation,
): Result<ConfinedPath, PackAuthoringError> {
  if (typeof candidate !== 'string' || candidate.length === 0 || isAbsolute(candidate)) {
    return err(
      pathError(
        'pack-source-path-invalid',
        operation,
        'a non-empty game-root-relative .pack.ts or .pack.json path',
        'pass a relative source locator inside the selected game root',
        { sourcePath: candidate },
        typeof candidate === 'string' ? candidate : undefined,
      ),
    );
  }
  const root = resolve(gameRoot);
  const absolute = resolve(root, candidate);
  const relativePath = relative(root, absolute).split(sep).join('/');
  if (
    relativePath.length === 0 ||
    relativePath === '..' ||
    relativePath.startsWith('../') ||
    (!relativePath.endsWith('.pack.ts') && !relativePath.endsWith('.pack.json'))
  ) {
    return err(
      pathError(
        'pack-source-path-invalid',
        operation,
        'a game-root-relative .pack.ts or .pack.json path',
        'choose a Pack source path inside the selected game root',
        { sourcePath: candidate },
        candidate,
      ),
    );
  }
  return ok({ absolute, relative: relativePath });
}

async function atomicWrite(path: string, source: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temporary, source, { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, path);
  } catch (cause) {
    await rm(temporary, { force: true });
    throw cause;
  }
}

function packageKey(packageId: PackageId): string {
  return PackageId.format(packageId).toLowerCase();
}

function parsePackageId(value: unknown): PackageId | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = PackageId.parse(value);
  return parsed.ok ? parsed.value : undefined;
}

function serializedParameters(
  definition: AnyScriptablePackDefinition,
): readonly Readonly<Record<string, unknown>>[] | undefined {
  if (!('parameters' in definition)) return undefined;
  return definition.parameters.map((parameter) => ({
    name: parameter.name,
    type: parameter.type,
    default: jsonValue(parameter.default),
    ...(parameter.minimum === undefined ? {} : { minimum: parameter.minimum }),
    ...(parameter.maximum === undefined ? {} : { maximum: parameter.maximum }),
    ...(parameter.values === undefined ? {} : { values: parameter.values }),
    ...(parameter.kind === undefined ? {} : { kind: parameter.kind }),
  }));
}

function sourceResult(
  subject: Subject,
  operation: PackAuthoringOperation,
): PackAuthoringOperationResult {
  const base = {
    operation: operation.operation,
    requestId: operation.requestId,
    sourcePath: subject.relativePath,
    packageId: PackageId.format(subject.packageId),
    format: subject.format === 'source' ? 'pack.ts' : subject.format,
  } as const;
  if (subject.format === 'source') {
    const parameters = serializedParameters(subject.definition);
    return {
      ...base,
      ...(parameters === undefined ? {} : { parameters }),
      ...(parameters === undefined
        ? {}
        : {
            capabilities: [
              'asset-source.create-instance',
              'asset-source.rebuild',
              'asset-source.cold-cook',
            ],
          }),
    };
  }
  if (subject.format === 'instance') {
    return {
      ...base,
      parentPackageId: PackageId.format(subject.parent),
      values: jsonValue(subject.values) as Readonly<Record<string, unknown>>,
    };
  }
  return {
    ...base,
    assets: subject.assets.map((asset) => ({
      sourceKey: asset.sourceKey,
      guid: asset.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      refs: asset.refs,
    })),
  };
}

function scanFailure(operation: PackAuthoringOperation, cause: unknown): PackAuthoringError {
  const value =
    cause !== null && typeof cause === 'object' ? (cause as Record<string, unknown>) : {};
  const detail = value.detail !== null && typeof value.detail === 'object' ? value.detail : {};
  const reason = isRecord(detail) && typeof detail.reason === 'string' ? detail.reason : undefined;
  const code: PackAuthoringErrorCode =
    reason === 'pack-parent-not-found' ||
    reason === 'pack-parent-cycle' ||
    reason === 'pack-parent-has-no-parameters'
      ? reason
      : value.code === 'pack-guid-collision'
        ? 'pack-guid-collision'
        : 'pack-parameter-invalid';
  return makeError(
    code,
    typeof value.expected === 'string' ? value.expected : 'a valid Pack Source Index',
    typeof value.hint === 'string'
      ? value.hint
      : 'repair the first source or package diagnostic, then retry',
    { requestId: operation.requestId, cause: value.detail ?? String(cause) },
  );
}

function scanRoots(options: FileSystemPackAuthoringOptions): readonly string[] {
  return options.scanRoots === undefined || options.scanRoots.length === 0
    ? [resolve(options.gameRoot)]
    : options.scanRoots.map((root) => resolve(options.gameRoot, root));
}

async function readMaterialized(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<Result<readonly MaterializedAsset[], PackAuthoringError>> {
  let rawRows: unknown;
  try {
    rawRows = (await options.materialized?.()) ?? [];
  } catch (cause) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'the materialized projection callback to return current-generation rows',
        'repair the build-owner projection callback, then retry the Pack operation',
        {
          requestId: operation.requestId,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      ),
    );
  }
  if (!Array.isArray(rawRows)) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'the materialized projection callback to return an array',
        'repair the build-owner projection callback, then retry the Pack operation',
        { requestId: operation.requestId, actual: typeof rawRows },
      ),
    );
  }
  const materialized: MaterializedAsset[] = [];
  const pairOwners = new Map<string, string>();
  const guidOwners = new Map<string, string>();
  for (const rawRow of rawRows) {
    if (!isRecord(rawRow)) {
      return err(
        makeError(
          'pack-parameter-invalid',
          'materialized rows to be objects',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, actual: typeof rawRow },
        ),
      );
    }
    const row = rawRow as unknown as PackAuthoringMaterializedAsset;
    const parsedPackageId = parsePackageId(row.packageId);
    if (parsedPackageId === undefined) {
      return err(
        makeError(
          'pack-package-id-invalid',
          'materialized rows to contain a valid UUID packageId',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, packageId: row.packageId, sourceKey: row.sourceKey },
        ),
      );
    }
    if (!isValidPackSourceKey(row.sourceKey)) {
      return err(
        makeError(
          'pack-source-key-invalid',
          'materialized rows to contain a valid sourceKey',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, packageId: row.packageId, sourceKey: row.sourceKey },
        ),
      );
    }
    if (
      typeof row.guid !== 'string' ||
      !isValidAssetGuidString(row.guid) ||
      typeof row.kind !== 'string' ||
      row.kind.length === 0
    ) {
      return err(
        makeError(
          'pack-parameter-invalid',
          'materialized rows to contain a valid GUID and non-empty kind',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, packageId: row.packageId, sourceKey: row.sourceKey },
        ),
      );
    }
    if (
      row.refs !== undefined &&
      (!Array.isArray(row.refs) ||
        row.refs.some((ref) => typeof ref !== 'string' || !isValidAssetGuidString(ref)))
    ) {
      return err(
        makeError(
          'pack-parameter-invalid',
          'materialized refs to contain UUID AssetGuid strings when present',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, packageId: row.packageId, sourceKey: row.sourceKey },
        ),
      );
    }
    if (row.sourcePath !== undefined && typeof row.sourcePath !== 'string') {
      return err(
        makeError(
          'pack-parameter-invalid',
          'materialized sourcePath to be a string when present',
          'repair the current generation projection before querying Pack authoring',
          { requestId: operation.requestId, sourcePath: row.sourcePath },
        ),
      );
    }
    const packageId = PackageId.format(parsedPackageId).toLowerCase();
    const expectedGuid = AssetGuid.format(
      AssetGuid.derive(parsedPackageId, row.sourceKey),
    ).toLowerCase();
    const guid = row.guid.toLowerCase();
    if (guid !== expectedGuid) {
      return err(
        makeError(
          'pack-guid-collision',
          'materialized GUID to equal UUIDv5(packageId, sourceKey)',
          'rebuild the current generation from the stable packageId and sourceKey pair',
          {
            requestId: operation.requestId,
            packageId,
            sourceKey: row.sourceKey,
            expectedGuid,
            observedGuid: row.guid,
          },
        ),
      );
    }
    const pair = `${packageId}/${row.sourceKey}`;
    const pairOwner = pairOwners.get(pair);
    if (pairOwner !== undefined) {
      return err(
        makeError(
          'pack-guid-collision',
          'one materialized row per packageId/sourceKey pair',
          'remove the stale duplicate row from the current generation projection',
          { requestId: operation.requestId, pair, paths: [pairOwner, row.sourcePath] },
        ),
      );
    }
    pairOwners.set(pair, row.sourcePath ?? pair);
    const guidOwner = guidOwners.get(guid);
    if (guidOwner !== undefined) {
      return err(
        makeError(
          'pack-guid-collision',
          'one materialized owner per derived AssetGuid',
          'repair the current generation projection so each derived GUID has one owner',
          { requestId: operation.requestId, guid, paths: [guidOwner, row.sourcePath] },
        ),
      );
    }
    guidOwners.set(guid, row.sourcePath ?? pair);
    materialized.push({
      packageId,
      sourceKey: row.sourceKey,
      guid,
      kind: row.kind,
      ...(row.sourcePath === undefined ? {} : { sourcePath: row.sourcePath }),
      ...(row.refs === undefined ? {} : { refs: Object.freeze([...row.refs]) }),
      ready: row.ready === true && row.artifactsReady !== false,
    });
  }
  materialized.sort((left, right) =>
    `${left.packageId}/${left.sourceKey}`.localeCompare(`${right.packageId}/${right.sourceKey}`),
  );
  return ok(materialized);
}

async function createSnapshot(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<Result<GatewaySnapshot, PackAuthoringError>> {
  const scanned =
    options.inventory === undefined
      ? await scanInventory(scanRoots(options))
      : await options.inventory();
  if (!scanned.ok) return err(scanFailure(operation, scanned.error));
  const subjects = new Map<string, Subject>();
  const directAssets: DirectAuthorAsset[] = [];
  for (const [sourcePath, declaration] of scanned.value.declarations) {
    const relativePath = relative(resolve(options.gameRoot), sourcePath).split(sep).join('/');
    if (declaration.format === 'pack.ts') {
      subjects.set(packageKey(declaration.definition.packageId), {
        format: 'source',
        packageId: declaration.definition.packageId,
        sourcePath,
        relativePath,
        definition: declaration.definition,
      });
      continue;
    }
    if (declaration.format !== 'pack.json' || declaration.value.schemaVersion !== '3.0.0') continue;
    const parsed = parsePackSourceJson(declaration.value);
    if (!parsed.ok) return err(parsed.error);
    if (parsed.value.format === 'direct') {
      const projected = projectDirectPackJson(parsed.value);
      if (!projected.ok) return err(projected.error);
      const subject: DirectSubject = {
        format: 'direct',
        packageId: parsed.value.packageId,
        sourcePath,
        relativePath,
        assets: projected.value.assets,
      };
      subjects.set(packageKey(subject.packageId), subject);
      directAssets.push(
        ...projected.value.assets.map((asset) => ({
          packageId: projected.value.packageId.toLowerCase(),
          sourceKey: asset.sourceKey,
          guid: asset.guid.toLowerCase(),
          kind: asset.kind,
          sourcePath: relativePath,
          ...(asset.name === undefined ? {} : { name: asset.name }),
          refs: asset.refs,
        })),
      );
    } else {
      subjects.set(packageKey(parsed.value.packageId), {
        format: 'instance',
        packageId: parsed.value.packageId,
        parent: parsed.value.parent,
        values: parsed.value.values,
        sourcePath,
        relativePath,
      });
    }
  }
  const materializedResult = await readMaterialized(options, operation);
  if (!materializedResult.ok) return materializedResult;
  const materialized = materializedResult.value;
  const guidOwners = new Map<string, string>();
  const directPairs = new Set<string>();
  for (const entry of scanned.value.inventory) {
    const declaration = scanned.value.declarations.get(entry.sourcePath);
    // scanInventory already projects v3 direct entries below; keep that
    // source-local projection from colliding with its gateway subject copy.
    if (declaration?.format === 'pack.json' && declaration.value.schemaVersion === '3.0.0') {
      continue;
    }
    guidOwners.set(entry.guid.toLowerCase(), entry.sourcePath);
  }
  for (const asset of directAssets) {
    directPairs.add(`${asset.packageId}/${asset.sourceKey}`);
    const existing = guidOwners.get(asset.guid);
    if (existing !== undefined) {
      return err(
        makeError(
          'pack-guid-collision',
          'one current-generation owner per AssetGuid',
          'repair the direct Pack or external source projection before querying Pack authoring',
          {
            requestId: operation.requestId,
            guid: asset.guid,
            paths: [existing, asset.sourcePath],
          },
        ),
      );
    }
    guidOwners.set(asset.guid, asset.sourcePath ?? asset.packageId);
  }
  for (const asset of materialized) {
    const existing = guidOwners.get(asset.guid);
    const pair = `${asset.packageId}/${asset.sourceKey}`;
    // A published row for a direct author asset is the expected current
    // generation. It shares the source identity; only a different owner is a
    // collision.
    if (existing !== undefined && !directPairs.has(pair)) {
      return err(
        makeError(
          'pack-guid-collision',
          'one current-generation owner per AssetGuid',
          'remove the stale materialized row or repair the direct/source owner before querying Pack authoring',
          {
            requestId: operation.requestId,
            guid: asset.guid,
            paths: [existing, asset.sourcePath],
          },
        ),
      );
    }
    guidOwners.set(asset.guid, asset.sourcePath ?? asset.packageId);
  }
  const knownGuids = new Set<string>([
    ...scanned.value.inventory.map((entry) => entry.guid.toLowerCase()),
    ...directAssets.map((asset) => asset.guid),
    ...materialized.map((asset) => asset.guid),
  ]);
  return ok({ inventory: scanned.value, subjects, directAssets, materialized, knownGuids });
}

function parentSubject(
  snapshot: GatewaySnapshot,
  packageId: PackageId,
): PackParameterInheritanceSubject | undefined {
  const subject = snapshot.subjects.get(packageKey(packageId));
  if (subject === undefined) return undefined;
  if (subject.format === 'source') {
    return {
      format: 'source',
      packageId: subject.packageId,
      parameters: 'parameters' in subject.definition ? subject.definition.parameters : [],
    };
  }
  if (subject.format === 'instance') {
    return {
      format: 'instance',
      packageId: subject.packageId,
      parent: subject.parent,
      values: subject.values,
    };
  }
  return { format: 'direct', packageId: subject.packageId };
}

async function resolveInstance(
  snapshot: GatewaySnapshot,
  subject: InstanceSubject,
): Promise<Result<ResolvedPackParameterInheritance, PackAuthoringError>> {
  return resolvePackParameterInheritance(
    {
      format: 'instance',
      packageId: subject.packageId,
      parent: subject.parent,
      values: subject.values,
    },
    async (packageId) => parentSubject(snapshot, packageId),
  );
}

function subjectFor(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Result<Subject, PackAuthoringError> {
  if (operation.sourcePath !== undefined) {
    const confined = confinedPath(gameRoot, operation.sourcePath, operation);
    if (!confined.ok) return confined;
    const expected = confined.value.relative;
    const source = [...snapshot.subjects.values()].find(
      (candidate) => candidate.relativePath === expected,
    );
    if (source !== undefined) {
      const requestedPackageId =
        operation.packageId === undefined ? undefined : PackageId.parse(operation.packageId);
      if (requestedPackageId?.ok === false) {
        return err(
          makeError(
            'pack-package-id-invalid',
            'a UUID packageId',
            'repair packageId before querying the Pack subject',
            { requestId: operation.requestId, packageId: operation.packageId },
            operation.packageId,
          ),
        );
      }
      if (
        requestedPackageId?.ok === true &&
        packageKey(requestedPackageId.value) !== packageKey(source.packageId)
      ) {
        return err(
          makeError(
            'pack-parameter-invalid',
            'sourcePath and packageId to identify the same Pack subject',
            'remove the conflicting locator or use the packageId returned by asset.list',
            {
              requestId: operation.requestId,
              sourcePath: expected,
              packageId: operation.packageId,
              observedPackageId: PackageId.format(source.packageId),
            },
          ),
        );
      }
      return ok(source);
    }
    return err(
      pathError(
        'pack-source-not-found',
        operation,
        'sourcePath to identify a current Pack subject',
        'inspect the current Source Index and choose an existing source path',
        { sourcePath: expected },
        expected,
      ),
    );
  }
  if (operation.packageId !== undefined) {
    const parsed = PackageId.parse(operation.packageId);
    if (!parsed.ok) {
      return err(
        makeError(
          'pack-package-id-invalid',
          'a UUID packageId',
          'repair packageId before querying the Pack',
          { requestId: operation.requestId, packageId: operation.packageId },
          operation.packageId,
        ),
      );
    }
    const subject = snapshot.subjects.get(packageKey(parsed.value));
    if (subject !== undefined) return ok(subject);
    return err(
      makeError(
        'pack-source-not-found',
        'packageId to exist in the current Source Index',
        'inspect the current source index and choose an existing packageId',
        { requestId: operation.requestId, packageId: operation.packageId },
      ),
    );
  }
  if (operation.subject !== undefined && !isValidAssetGuidString(operation.subject)) {
    const confined = confinedPath(gameRoot, operation.subject, operation);
    if (!confined.ok) return confined;
    const source = [...snapshot.subjects.values()].find(
      (candidate) => candidate.relativePath === confined.value.relative,
    );
    if (source !== undefined) return ok(source);
  }
  if (operation.subject !== undefined && isValidAssetGuidString(operation.subject)) {
    const guid = operation.subject.toLowerCase();
    const packageSubject = snapshot.subjects.get(guid);
    if (packageSubject !== undefined) return ok(packageSubject);
    const asset = [...snapshot.directAssets, ...snapshot.materialized].find(
      (candidate) => candidate.guid === guid,
    );
    if (asset !== undefined) {
      const subject = snapshot.subjects.get(asset.packageId);
      if (subject !== undefined) return ok(subject);
    }
  }
  return err(
    makeError(
      'pack-source-not-found',
      'a packageId, source path, or known AssetGuid subject',
      'run asset.list or asset.inspect to obtain a current subject locator',
      { requestId: operation.requestId, subject: operation.subject },
    ),
  );
}

async function inspectAsset(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  const selected = subjectFor(gameRoot, snapshot, operation);
  if (!selected.ok) return selected;
  const subject = selected.value;
  if (operation.sourceKey !== undefined) {
    if (!isValidPackSourceKey(operation.sourceKey)) {
      return err(
        makeError(
          'pack-source-key-invalid',
          'a stable lower-case sourceKey',
          'repair sourceKey before inspecting the output identity',
          { requestId: operation.requestId, sourceKey: operation.sourceKey },
          operation.sourceKey,
        ),
      );
    }
    if (subject.format === 'direct') {
      const asset = subject.assets.find((candidate) => candidate.sourceKey === operation.sourceKey);
      if (asset === undefined) {
        return err(
          makeError(
            'pack-output-not-materialized',
            'sourceKey to exist in the direct Pack',
            'inspect the current source and choose an existing sourceKey',
            {
              requestId: operation.requestId,
              sourceKey: operation.sourceKey,
              packageId: PackageId.format(subject.packageId),
            },
          ),
        );
      }
      const materialized = snapshot.materialized.find(
        (candidate) =>
          candidate.packageId === packageKey(subject.packageId) &&
          candidate.sourceKey === operation.sourceKey,
      );
      return ok({
        ...sourceResult(subject, operation),
        sourceKey: asset.sourceKey,
        guid: asset.guid,
        kind: asset.kind,
        status:
          materialized === undefined
            ? ('identity' as const)
            : materialized.ready
              ? 'ready'
              : 'present',
      });
    }
    try {
      const guid = AssetGuid.format(AssetGuid.derive(subject.packageId, operation.sourceKey));
      const materialized = [...snapshot.materialized].find(
        (candidate) =>
          candidate.packageId === packageKey(subject.packageId) &&
          candidate.sourceKey === operation.sourceKey,
      );
      return ok({
        ...sourceResult(subject, operation),
        sourceKey: operation.sourceKey,
        guid,
        ...(materialized === undefined
          ? { status: 'identity' as const }
          : {
              status: materialized.ready ? ('ready' as const) : ('present' as const),
              kind: materialized.kind,
            }),
      });
    } catch (cause) {
      return err(
        makeError(
          'pack-source-key-invalid',
          'a valid lower-case sourceKey',
          'repair sourceKey before inspecting the output identity',
          { requestId: operation.requestId, sourceKey: operation.sourceKey, cause: String(cause) },
          operation.sourceKey,
        ),
      );
    }
  }
  if (subject.format === 'instance') {
    const resolved = await resolveInstance(snapshot, subject);
    if (!resolved.ok) return resolved;
    return ok({
      ...sourceResult(subject, operation),
      parameters: resolved.value.parameters.map((parameter) => ({
        name: parameter.name,
        type: parameter.type,
        default: jsonValue(parameter.default),
        ...(parameter.minimum === undefined ? {} : { minimum: parameter.minimum }),
        ...(parameter.maximum === undefined ? {} : { maximum: parameter.maximum }),
        ...(parameter.values === undefined ? {} : { values: parameter.values }),
        ...(parameter.kind === undefined ? {} : { kind: parameter.kind }),
      })),
      effectiveValues: jsonValue(resolved.value.values) as Readonly<Record<string, unknown>>,
      parentChain: resolved.value.parentChain,
    });
  }
  return ok(sourceResult(subject, operation));
}

function listAssets(
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): PackAuthoringOperationResult {
  const assets = snapshotAssets(snapshot)
    .map((asset) => ({
      packageId: asset.packageId,
      sourceKey: asset.sourceKey,
      guid: asset.guid,
      kind: asset.kind,
      ...(asset.name === undefined ? {} : { name: asset.name }),
      ...(asset.sourcePath === undefined ? {} : { sourcePath: asset.sourcePath }),
      status: !('ready' in asset)
        ? ('identity' as const)
        : asset.ready
          ? ('ready' as const)
          : ('present' as const),
    }))
    .sort((left, right) =>
      `${left.packageId}/${left.sourceKey}`.localeCompare(`${right.packageId}/${right.sourceKey}`),
    );
  const sources = [...snapshot.subjects.values()]
    .map((subject) => {
      if (subject.format === 'source') {
        const parameters = serializedParameters(subject.definition);
        return {
          packageId: PackageId.format(subject.packageId),
          sourcePath: subject.relativePath,
          format: 'pack.ts' as const,
          ...(parameters === undefined ? {} : { parameters }),
        };
      }
      if (subject.format === 'instance') {
        return {
          packageId: PackageId.format(subject.packageId),
          sourcePath: subject.relativePath,
          format: 'instance' as const,
          parentPackageId: PackageId.format(subject.parent),
          values: jsonValue(subject.values) as Readonly<Record<string, unknown>>,
        };
      }
      return {
        packageId: PackageId.format(subject.packageId),
        sourcePath: subject.relativePath,
        format: 'direct' as const,
      };
    })
    .sort((left, right) =>
      `${left.packageId}/${left.sourcePath}`.localeCompare(
        `${right.packageId}/${right.sourcePath}`,
      ),
    );
  return {
    operation: operation.operation,
    requestId: operation.requestId,
    assets,
    sources,
    snapshot: { sourceCount: snapshot.subjects.size, assetCount: assets.length },
  };
}

function snapshotAssets(
  snapshot: GatewaySnapshot,
): readonly (DirectAuthorAsset | MaterializedAsset)[] {
  const assets = new Map<string, DirectAuthorAsset | MaterializedAsset>();
  for (const asset of snapshot.directAssets) {
    assets.set(`${asset.packageId}/${asset.sourceKey}`, asset);
  }
  for (const asset of snapshot.materialized) {
    assets.set(`${asset.packageId}/${asset.sourceKey}`, asset);
  }
  return [...assets.values()];
}

function assetForPair(
  snapshot: GatewaySnapshot,
  packageId: PackageId,
  sourceKey: string,
): DirectAuthorAsset | MaterializedAsset | undefined {
  const key = `${packageKey(packageId)}/${sourceKey}`;
  return snapshotAssets(snapshot).find((asset) => `${asset.packageId}/${asset.sourceKey}` === key);
}

async function resolveAsset(
  gameRoot: string,
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  if (
    operation.require !== undefined &&
    operation.require !== 'identity' &&
    operation.require !== 'present' &&
    operation.require !== 'ready'
  ) {
    return err(
      makeError(
        'pack-parameter-invalid',
        "require to be 'identity', 'present', or 'ready'",
        'choose one of the three Pack identity proof levels',
        { requestId: operation.requestId, require: operation.require },
      ),
    );
  }
  let packageId: PackageId | undefined;
  let sourceKey = operation.sourceKey;
  let resolvedOutputGuid: string | undefined;
  if (operation.packageId !== undefined) {
    const parsed = PackageId.parse(operation.packageId);
    if (!parsed.ok) {
      return err(
        makeError(
          'pack-package-id-invalid',
          'a UUID packageId',
          'repair packageId before resolving a sourceKey',
          { requestId: operation.requestId },
          operation.packageId,
        ),
      );
    }
    packageId = parsed.value;
  }
  if (operation.subject !== undefined && isValidAssetGuidString(operation.subject)) {
    const found = [...snapshot.directAssets, ...snapshot.materialized].find(
      (asset) => asset.guid === operation.subject?.toLowerCase(),
    );
    if (found !== undefined) {
      const parsed = PackageId.parse(found.packageId);
      if (parsed.ok) {
        if (packageId !== undefined && packageKey(packageId) !== packageKey(parsed.value)) {
          return err(
            makeError(
              'pack-parameter-invalid',
              'packageId and AssetGuid to identify the same Pack subject',
              'remove the conflicting locator or resolve the pair from one source',
              {
                requestId: operation.requestId,
                packageId: PackageId.format(packageId),
                observedPackageId: found.packageId,
                guid: operation.subject,
              },
            ),
          );
        }
        if (sourceKey !== undefined && sourceKey !== found.sourceKey) {
          return err(
            makeError(
              'pack-parameter-invalid',
              'sourceKey and AssetGuid to identify the same Pack output',
              'remove the conflicting locator or use the sourceKey returned by asset.list',
              {
                requestId: operation.requestId,
                sourceKey,
                observedSourceKey: found.sourceKey,
                guid: operation.subject,
              },
            ),
          );
        }
        packageId = parsed.value;
        sourceKey ??= found.sourceKey;
        resolvedOutputGuid = found.guid;
      }
    }
  }
  if (
    packageId === undefined &&
    operation.subject !== undefined &&
    isValidAssetGuidString(operation.subject)
  ) {
    const parsed = PackageId.parse(operation.subject);
    if (parsed.ok) packageId = parsed.value;
  }
  const sourceLocatorCandidate =
    operation.sourcePath ??
    (operation.subject !== undefined && !isValidAssetGuidString(operation.subject)
      ? operation.subject
      : undefined);
  let sourceLocator: string | undefined;
  if (sourceLocatorCandidate !== undefined) {
    const confined = confinedPath(gameRoot, sourceLocatorCandidate, operation);
    if (!confined.ok) return confined;
    sourceLocator = confined.value.relative;
  }
  if (sourceLocator !== undefined) {
    const source = [...snapshot.subjects.values()].find(
      (candidate) => candidate.relativePath === sourceLocator,
    );
    if (source === undefined) {
      return err(
        pathError(
          'pack-source-not-found',
          operation,
          'sourcePath to identify a current Pack subject',
          'inspect the current Source Index and choose an existing source path',
          { sourcePath: sourceLocator },
          sourceLocator,
        ),
      );
    }
    if (packageId !== undefined && packageKey(packageId) !== packageKey(source.packageId)) {
      return err(
        makeError(
          'pack-parameter-invalid',
          'sourcePath and packageId to identify the same Pack subject',
          'remove the conflicting locator or use the packageId returned by asset.list',
          {
            requestId: operation.requestId,
            sourcePath: sourceLocator,
            packageId: PackageId.format(packageId),
            observedPackageId: PackageId.format(source.packageId),
          },
        ),
      );
    }
    packageId ??= source.packageId;
  }
  if (packageId === undefined || sourceKey === undefined) {
    return err(
      makeError(
        'pack-parameter-invalid',
        'packageId and sourceKey (or a known output GUID)',
        'pass packageId + sourceKey, a known AssetGuid, or a source path plus sourceKey',
        { requestId: operation.requestId, packageId: operation.packageId, sourceKey },
      ),
    );
  }
  if (!isValidPackSourceKey(sourceKey)) {
    return err(
      makeError(
        'pack-source-key-invalid',
        'a stable lower-case sourceKey',
        'repair sourceKey before deriving its AssetGuid',
        { requestId: operation.requestId, sourceKey },
        sourceKey,
      ),
    );
  }
  let guid: EngineAssetGuid;
  try {
    guid = AssetGuid.derive(packageId, sourceKey);
  } catch (cause) {
    return err(
      makeError(
        'pack-source-key-invalid',
        'a valid packageId and sourceKey pair',
        'repair the identity pair before resolving',
        {
          requestId: operation.requestId,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
      ),
    );
  }
  const guidString = AssetGuid.format(guid);
  if (resolvedOutputGuid !== undefined && guidString.toLowerCase() !== resolvedOutputGuid) {
    return err(
      makeError(
        'pack-guid-collision',
        'the known output GUID to equal UUIDv5(packageId, sourceKey)',
        'rebuild the current generation from the stable identity pair',
        {
          requestId: operation.requestId,
          packageId: PackageId.format(packageId),
          sourceKey,
          expectedGuid: guidString,
          observedGuid: resolvedOutputGuid,
        },
      ),
    );
  }
  const asset = assetForPair(snapshot, packageId, sourceKey);
  const materialized = snapshot.materialized.find(
    (candidate) =>
      candidate.packageId === packageKey(packageId) && candidate.sourceKey === sourceKey,
  );
  const requirement: PackAuthoringResolutionStatus = operation.require ?? 'identity';
  if (requirement === 'present' && materialized === undefined) {
    return err(
      makeError(
        'pack-output-not-materialized',
        'the current build topology to contain this sourceKey',
        'run rebuild/cold-cook and retry after the current generation publishes the output',
        {
          requestId: operation.requestId,
          packageId: PackageId.format(packageId),
          sourceKey,
          guid: guidString,
        },
      ),
    );
  }
  if (requirement === 'ready' && (materialized === undefined || !materialized.ready)) {
    return err(
      makeError(
        'asset-not-ready',
        'current Pack evidence and artifacts for this derived GUID',
        'inspect producer evidence, then rebuild or cold-cook the same subject',
        {
          requestId: operation.requestId,
          packageId: PackageId.format(packageId),
          sourceKey,
          guid: guidString,
        },
      ),
    );
  }
  return ok({
    operation: operation.operation,
    requestId: operation.requestId,
    packageId: PackageId.format(packageId),
    sourceKey,
    guid: guidString,
    status: materialized === undefined ? 'identity' : materialized.ready ? 'ready' : 'present',
    ...(asset === undefined
      ? {}
      : {
          ...(asset.sourcePath === undefined ? {} : { sourcePath: asset.sourcePath }),
          kind: asset.kind,
        }),
  });
}

async function verify(
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  for (const subject of snapshot.subjects.values()) {
    if (subject.format === 'instance') {
      const resolved = await resolveInstance(snapshot, subject);
      if (!resolved.ok) return err(resolved.error);
    }
    if (subject.format === 'direct') {
      for (const asset of subject.assets) {
        const missing = asset.refs.find((ref) => !snapshot.knownGuids.has(ref.toLowerCase()));
        if (missing !== undefined) {
          return err(
            makeError(
              'pack-output-reference-missing',
              'every direct Pack ref to resolve to a known AssetGuid',
              'repair the payload ref or add the owning external asset before verifying',
              {
                requestId: operation.requestId,
                packageId: PackageId.format(subject.packageId),
                sourceKey: asset.sourceKey,
                guid: missing,
              },
            ),
          );
        }
      }
    }
  }
  for (const asset of snapshotAssets(snapshot)) {
    const missing = asset.refs?.find((ref) => !snapshot.knownGuids.has(ref.toLowerCase()));
    if (missing !== undefined) {
      return err(
        makeError(
          'pack-output-reference-missing',
          'every materialized Pack ref to resolve to a known AssetGuid',
          'repair the published output reference or publish its owning asset before verifying',
          {
            requestId: operation.requestId,
            packageId: asset.packageId,
            sourceKey: asset.sourceKey,
            guid: missing,
          },
        ),
      );
    }
  }
  return ok({
    operation: operation.operation,
    requestId: operation.requestId,
    snapshot: {
      sourceCount: snapshot.subjects.size,
      assetCount: snapshotAssets(snapshot).length,
    },
  });
}

function packageIdFromOperation(
  snapshot: GatewaySnapshot,
  operation: PackAuthoringOperation,
): Result<PackageId, PackAuthoringError> {
  const value =
    operation.packageId === undefined
      ? ok(PackageId.random())
      : PackageId.parse(operation.packageId);
  if (!value.ok) {
    return err(
      makeError(
        'pack-package-id-invalid',
        'a UUID packageId',
        'repair packageId or omit it so the gateway can mint one',
        { requestId: operation.requestId },
        operation.packageId,
      ),
    );
  }
  const normalized = packageKey(value.value);
  const alreadyMaterialized = snapshot.materialized.some((asset) => asset.packageId === normalized);
  return snapshot.subjects.has(normalized) || alreadyMaterialized
    ? err(
        makeError(
          'pack-package-id-collision',
          'a packageId unused by the current Source Index',
          'choose a new packageId or use clone without an explicit identity',
          { requestId: operation.requestId, packageId: PackageId.format(value.value) },
        ),
      )
    : ok(value.value);
}

async function readConfined(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
  sourcePath: unknown,
): Promise<
  Result<ConfinedPath & { readonly source: string; readonly revision: string }, PackAuthoringError>
> {
  const path = confinedPath(options.gameRoot, sourcePath, operation);
  if (!path.ok) return path;
  try {
    const source = await readFile(path.value.absolute, 'utf8');
    return ok({ ...path.value, source, revision: revisionOf(source) });
  } catch (cause) {
    const code: 'pack-source-not-found' | 'pack-source-write-failed' =
      (cause as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'pack-source-not-found'
        : 'pack-source-write-failed';
    return err(
      pathError(
        code,
        operation,
        'the requested Pack source to be readable',
        'restore the source or choose a current locator',
        {
          sourcePath: path.value.relative,
          cause: cause instanceof Error ? cause.message : String(cause),
        },
        path.value.relative,
      ),
    );
  }
}

function revisionConflict(
  operation: PackAuthoringOperation,
  path: string,
  actual: string,
): PackAuthoringError {
  return makeError(
    'pack-source-revision-conflict',
    'expectedRevision to match the current source bytes',
    'inspect the current source, reconcile the edit, and retry with a new requestId',
    {
      requestId: operation.requestId,
      sourcePath: path,
      expectedRevision: operation.expectedRevision,
      actualRevision: actual,
    },
    actual,
  );
}

function directJson(
  packageId: PackageId,
  assets: Readonly<Record<string, DirectPackJsonAsset>>,
): Record<string, unknown> {
  return { schemaVersion: '3.0.0', packageId: PackageId.format(packageId), assets };
}

function packSourceScaffold(
  packageId: PackageId,
  parameters: readonly PackParameterDefinition[] | undefined,
): string {
  const parameterSource =
    parameters === undefined
      ? ''
      : '\n  parameters: ' +
        JSON.stringify(
          parameters.map((parameter) => jsonValue(parameter)),
          null,
          2,
        ).replaceAll('\n', '\n  ') +
        ',';
  return (
    "import { definePack, definePackageId } from '@forgeax/engine-pack/source';\n" +
    "import { ok } from '@forgeax/engine-types';\n\n" +
    'const packageId = definePackageId(' +
    JSON.stringify(PackageId.format(packageId)) +
    ');\n\n' +
    'export default definePack({\n' +
    "  schemaVersion: '2.0.0',\n" +
    '  packageId,' +
    parameterSource +
    '\n  build: () => ok({}),\n' +
    '});\n'
  );
}

function replacePackageIdLiteral(source: string, packageId: string): string | undefined {
  const pattern =
    /(definePackageId\s*\(\s*)(['"])([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})(\2\s*\))/;
  if (!pattern.test(source)) return undefined;
  return source.replace(pattern, `$1${JSON.stringify(packageId)}$4`);
}

async function inspectAfterWrite(
  operation: PackAuthoringOperation,
  path: ConfinedPath,
  source: string,
  packageId: PackageId,
  extra: Partial<PackAuthoringOperationResult> = {},
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  return ok({
    operation: operation.operation,
    requestId: operation.requestId,
    sourcePath: path.relative,
    targetPath: path.relative,
    packageId: PackageId.format(packageId),
    revision: revisionOf(source),
    ...extra,
  });
}

async function executeRaw(
  options: FileSystemPackAuthoringOptions,
  operation: PackAuthoringOperation,
): Promise<Result<PackAuthoringOperationResult, PackAuthoringError>> {
  if (operation.operation === 'asset.list' || operation.operation === 'asset.inspect') {
    const snapshot = await createSnapshot(options, operation);
    if (!snapshot.ok) return snapshot;
    return operation.operation === 'asset.list'
      ? ok(listAssets(snapshot.value, operation))
      : await inspectAsset(options.gameRoot, snapshot.value, operation);
  }
  const snapshot = await createSnapshot(options, operation);
  if (!snapshot.ok) return snapshot;
  if (operation.operation === 'asset.resolve')
    return resolveAsset(options.gameRoot, snapshot.value, operation);
  if (operation.operation === 'asset.verify') return verify(snapshot.value, operation);

  if (operation.operation === 'asset-source.create') {
    const path = confinedPath(
      options.gameRoot,
      operation.targetPath ?? operation.sourcePath,
      operation,
    );
    if (!path.ok) return path;
    try {
      await stat(path.value.absolute);
      return err(
        pathError(
          'pack-source-revision-conflict',
          operation,
          'an unused target source path',
          'inspect the existing source or choose another target path',
          { targetPath: path.value.relative },
          path.value.relative,
        ),
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        return err(
          pathError(
            'pack-source-write-failed',
            operation,
            'the target path to be available for atomic creation',
            'repair the filesystem and retry',
            { targetPath: path.value.relative, cause: String(cause) },
          ),
        );
      }
    }
    const identity = packageIdFromOperation(snapshot.value, operation);
    if (!identity.ok) return identity;
    const format =
      operation.format ?? (path.value.relative.endsWith('.pack.json') ? 'pack.json' : 'pack.ts');
    if (
      (format === 'pack.json' && !path.value.relative.endsWith('.pack.json')) ||
      (format === 'pack.ts' && !path.value.relative.endsWith('.pack.ts'))
    ) {
      return err(
        makeError(
          'pack-source-path-invalid',
          'format and target extension to agree',
          'use a .pack.ts target for source creation or a .pack.json target for direct data',
          { requestId: operation.requestId, format, targetPath: path.value.relative },
        ),
      );
    }
    let source: string;
    let extra: Partial<PackAuthoringOperationResult> = { format };
    if (format === 'pack.json') {
      if (
        operation.parameters !== undefined ||
        operation.parent !== undefined ||
        operation.parentPackageId !== undefined ||
        operation.values !== undefined
      ) {
        return err(
          makeError(
            'pack-parameter-invalid',
            'direct create to contain assets only',
            'use pack.ts for a ScriptablePack source or create-instance for parent+values',
            { requestId: operation.requestId },
          ),
        );
      }
      const assets = operation.initialAssets ?? {};
      const parsed = parsePackSourceJson(directJson(identity.value, assets));
      if (!parsed.ok) return err(parsed.error);
      if (parsed.value.format !== 'direct') {
        return err(
          makeError(
            'pack-parameter-invalid',
            'direct create to produce a direct v3 Pack document',
            'use create-instance for parent + values instead of direct assets',
            { requestId: operation.requestId },
          ),
        );
      }
      source = `${JSON.stringify(directJson(identity.value, parsed.value.assets), null, 2)}\n`;
    } else {
      if (
        operation.initialAssets !== undefined &&
        Object.keys(operation.initialAssets).length > 0
      ) {
        return err(
          makeError(
            'pack-parameter-invalid',
            'a pack.ts source to define its outputs in build()',
            'use pack.json for direct assets or omit initialAssets when creating a pack.ts source',
            { requestId: operation.requestId },
          ),
        );
      }
      if (
        operation.parent !== undefined ||
        operation.parentPackageId !== undefined ||
        operation.values !== undefined
      ) {
        return err(
          makeError(
            'pack-parameter-invalid',
            'a new pack.ts source without instance-only parent/value fields',
            'use asset-source.create-instance for parent + values',
            { requestId: operation.requestId },
          ),
        );
      }
      let parameters: readonly PackParameterDefinition[] | undefined;
      if (operation.parameters !== undefined) {
        const validated = validatePackDefinition({
          schemaVersion: '2.0.0',
          packageId: identity.value,
          parameters: operation.parameters,
          build: () => ok({}),
        });
        if (!validated.ok) return err(validated.error);
        if (!('parameters' in validated.value)) {
          return err(
            makeError(
              'pack-parameter-invalid',
              'parameters to be non-empty when supplied',
              'omit parameters for a zero-parameter Pack',
              { requestId: operation.requestId },
            ),
          );
        }
        parameters = validated.value.parameters;
      }
      source = packSourceScaffold(identity.value, parameters);
      const serialized =
        parameters === undefined
          ? undefined
          : serializedParameters({
              schemaVersion: '2.0.0',
              packageId: identity.value,
              parameters,
              build: () => ok({}),
            } as AnyScriptablePackDefinition);
      extra = {
        format,
        ...(serialized === undefined ? {} : { parameters: serialized }),
      };
    }
    try {
      await atomicWrite(path.value.absolute, source);
    } catch (cause) {
      return err(
        pathError(
          'pack-source-write-failed',
          operation,
          'the new Pack source to be written atomically',
          'repair filesystem permissions or disk capacity, then retry with a new requestId',
          {
            targetPath: path.value.relative,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      );
    }
    return inspectAfterWrite(operation, path.value, source, identity.value, extra);
  }

  if (operation.operation === 'asset-source.clone') {
    const read = await readConfined(options, operation, operation.sourcePath);
    if (!read.ok) return read;
    if (
      operation.expectedRevision !== undefined &&
      operation.expectedRevision !== read.value.revision
    ) {
      return err(revisionConflict(operation, read.value.relative, read.value.revision));
    }
    const target = confinedPath(options.gameRoot, operation.targetPath, operation);
    if (!target.ok) return target;
    const sourceIsTypeScript = read.value.relative.endsWith('.pack.ts');
    const targetIsTypeScript = target.value.relative.endsWith('.pack.ts');
    if (sourceIsTypeScript !== targetIsTypeScript) {
      return err(
        makeError(
          'pack-source-path-invalid',
          'clone source and target to use the same .pack.ts or .pack.json format',
          'preserve the source extension when cloning a Pack subject',
          {
            requestId: operation.requestId,
            sourcePath: read.value.relative,
            targetPath: target.value.relative,
          },
        ),
      );
    }
    try {
      await stat(target.value.absolute);
      return err(
        pathError(
          'pack-source-revision-conflict',
          operation,
          'an unused clone target path',
          'inspect the target or choose another path',
          { targetPath: target.value.relative },
          target.value.relative,
        ),
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        return err(
          pathError(
            'pack-source-write-failed',
            operation,
            'the clone target to be writable',
            'repair filesystem permissions and retry',
            { targetPath: target.value.relative, cause: String(cause) },
          ),
        );
      }
    }
    const identity = packageIdFromOperation(snapshot.value, operation);
    if (!identity.ok) return identity;
    let source = read.value.source;
    if (read.value.relative.endsWith('.pack.json')) {
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(source);
      } catch {
        return err(
          makeError(
            'pack-parameter-invalid',
            'a valid v3 pack.json document',
            'repair the source before cloning it',
            { requestId: operation.requestId, sourcePath: read.value.relative },
          ),
        );
      }
      const parsed = parsePackSourceJson(parsedValue);
      if (!parsed.ok) return err(parsed.error);
      source = `${JSON.stringify(
        parsed.value.format === 'direct'
          ? directJson(identity.value, parsed.value.assets)
          : {
              schemaVersion: '3.0.0',
              packageId: PackageId.format(identity.value),
              parent: PackageId.format(parsed.value.parent),
              values: parsed.value.values,
            },
        null,
        2,
      )}\n`;
    } else {
      const replaced = replacePackageIdLiteral(source, PackageId.format(identity.value));
      if (replaced === undefined) {
        return err(
          makeError(
            'pack-source-mutation-unsupported',
            'a constrained definePackageId(UUID) literal in the source',
            'clone a generated Pack source or create a new Pack; arbitrary TypeScript AST rewriting is unsupported',
            { requestId: operation.requestId, sourcePath: read.value.relative },
          ),
        );
      }
      source = replaced;
    }
    try {
      await atomicWrite(target.value.absolute, source);
    } catch (cause) {
      return err(
        pathError(
          'pack-source-write-failed',
          operation,
          'the cloned Pack source to be written atomically',
          'repair filesystem permissions or disk capacity, then retry',
          {
            targetPath: target.value.relative,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      );
    }
    return inspectAfterWrite(operation, target.value, source, identity.value, {
      format: target.value.relative.endsWith('.pack.json') ? 'pack.json' : 'pack.ts',
    });
  }

  if (operation.operation === 'asset-source.create-instance') {
    const target = confinedPath(
      options.gameRoot,
      operation.targetPath ?? operation.sourcePath,
      operation,
    );
    if (!target.ok) return target;
    const parentText = operation.parentPackageId ?? operation.parent;
    if (parentText === undefined) {
      return err(
        makeError(
          'pack-parent-not-found',
          'a parent packageId for the new instance',
          'pass parentPackageId or parent and point it at a ScriptablePack source with parameters',
          { requestId: operation.requestId },
        ),
      );
    }
    const parentId = PackageId.parse(parentText);
    if (!parentId.ok) {
      return err(
        makeError(
          'pack-package-id-invalid',
          'a UUID parent packageId',
          'repair the parent package identity',
          { requestId: operation.requestId },
          parentText,
        ),
      );
    }
    const parent = snapshot.value.subjects.get(packageKey(parentId.value));
    if (parent === undefined) {
      return err(
        makeError(
          'pack-parent-not-found',
          'the parent packageId to exist in the current Source Index',
          'inspect the Source Index and choose a ScriptablePack parent with parameters',
          { requestId: operation.requestId, parent: parentText },
        ),
      );
    }
    if (parent.format === 'source' && !('parameters' in parent.definition)) {
      return err(
        makeError(
          'pack-parent-has-no-parameters',
          'a ScriptablePack source with a non-empty parameter list as the parent',
          'use asset-source.clone for a zero-parameter Pack',
          { requestId: operation.requestId, parent: parentText },
        ),
      );
    }
    if (parent.format === 'direct') {
      return err(
        makeError(
          'pack-parent-has-no-parameters',
          'a ScriptablePack source or instance with parameters as the parent',
          'direct Packs cannot be instance parents',
          { requestId: operation.requestId, parent: parentText },
        ),
      );
    }
    try {
      await stat(target.value.absolute);
      return err(
        pathError(
          'pack-source-revision-conflict',
          operation,
          'an unused instance target path',
          'inspect the existing instance or choose another path',
          { targetPath: target.value.relative },
          target.value.relative,
        ),
      );
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== 'ENOENT') {
        return err(
          pathError(
            'pack-source-write-failed',
            operation,
            'the instance target to be writable',
            'repair filesystem permissions and retry',
            { targetPath: target.value.relative, cause: String(cause) },
          ),
        );
      }
    }
    const identity = packageIdFromOperation(snapshot.value, operation);
    if (!identity.ok) return identity;
    const values = operation.values ?? {};
    const serializedValues = jsonValue(values) as Readonly<Record<string, unknown>>;
    const candidate: InstanceSubject = {
      format: 'instance',
      packageId: identity.value,
      parent: parentId.value,
      values,
      sourcePath: target.value.absolute,
      relativePath: target.value.relative,
    };
    const withCandidate: GatewaySnapshot = {
      ...snapshot.value,
      subjects: new Map([...snapshot.value.subjects, [packageKey(identity.value), candidate]]),
    };
    const resolved = await resolveInstance(withCandidate, candidate);
    if (!resolved.ok) return err(resolved.error);
    const source = `${JSON.stringify(
      {
        schemaVersion: '3.0.0',
        packageId: PackageId.format(identity.value),
        parent: PackageId.format(parentId.value),
        values: serializedValues,
      },
      null,
      2,
    )}\n`;
    try {
      await atomicWrite(target.value.absolute, source);
    } catch (cause) {
      return err(
        pathError(
          'pack-source-write-failed',
          operation,
          'the new instance to be written atomically',
          'repair filesystem permissions or disk capacity, then retry',
          {
            targetPath: target.value.relative,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      );
    }
    return inspectAfterWrite(operation, target.value, source, identity.value, {
      format: 'instance',
      parentPackageId: PackageId.format(parentId.value),
      values: serializedValues,
      effectiveValues: jsonValue(resolved.value.values) as Readonly<Record<string, unknown>>,
      parentChain: resolved.value.parentChain,
    });
  }

  if (operation.operation === 'asset-source.apply-values') {
    const read = await readConfined(options, operation, operation.sourcePath);
    if (!read.ok) return read;
    if (
      operation.expectedRevision === undefined ||
      operation.expectedRevision !== read.value.revision
    ) {
      return err(revisionConflict(operation, read.value.relative, read.value.revision));
    }
    let json: unknown;
    try {
      json = JSON.parse(read.value.source);
    } catch {
      return err(
        makeError(
          'pack-parameter-invalid',
          'a valid v3 instance JSON document',
          'repair the source before applying values',
          { requestId: operation.requestId, sourcePath: read.value.relative },
        ),
      );
    }
    const parsed = parsePackSourceJson(json);
    if (!parsed.ok) return err(parsed.error);
    if (parsed.value.format !== 'instance') {
      return err(
        makeError(
          'pack-parameter-invalid',
          'an instance pack.json subject',
          'apply-values only edits parent+values instances',
          { requestId: operation.requestId, sourcePath: read.value.relative },
        ),
      );
    }
    const values = operation.values ?? {};
    const serializedValues = jsonValue(values) as Readonly<Record<string, unknown>>;
    const candidate: InstanceSubject = {
      format: 'instance',
      packageId: parsed.value.packageId,
      parent: parsed.value.parent,
      values,
      sourcePath: read.value.absolute,
      relativePath: read.value.relative,
    };
    const withCandidate: GatewaySnapshot = {
      ...snapshot.value,
      subjects: new Map([...snapshot.value.subjects, [packageKey(candidate.packageId), candidate]]),
    };
    const resolved = await resolveInstance(withCandidate, candidate);
    if (!resolved.ok) return err(resolved.error);
    const source = `${JSON.stringify(
      {
        schemaVersion: '3.0.0',
        packageId: PackageId.format(parsed.value.packageId),
        parent: PackageId.format(parsed.value.parent),
        values: serializedValues,
      },
      null,
      2,
    )}\n`;
    try {
      await atomicWrite(read.value.absolute, source);
    } catch (cause) {
      return err(
        pathError(
          'pack-source-write-failed',
          operation,
          'the updated instance to be written atomically',
          'repair filesystem permissions or disk capacity, then retry with a new requestId',
          {
            sourcePath: read.value.relative,
            cause: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      );
    }
    return inspectAfterWrite(operation, read.value, source, parsed.value.packageId, {
      format: 'instance',
      parentPackageId: PackageId.format(parsed.value.parent),
      values: serializedValues,
      effectiveValues: jsonValue(resolved.value.values) as Readonly<Record<string, unknown>>,
      parentChain: resolved.value.parentChain,
    });
  }

  if (
    operation.operation === 'asset-source.rebuild' ||
    operation.operation === 'asset-source.cold-cook'
  ) {
    const read = await readConfined(options, operation, operation.sourcePath);
    if (!read.ok) return read;
    if (
      operation.expectedRevision === undefined ||
      operation.expectedRevision !== read.value.revision
    ) {
      return err(revisionConflict(operation, read.value.relative, read.value.revision));
    }
    const rebuilt = await options.rebuild?.(
      read.value.relative,
      operation.operation === 'asset-source.rebuild' ? 'rebuild' : 'cold-cook',
    );
    if (rebuilt === undefined) {
      return err(
        makeError(
          'pack-source-mutation-unsupported',
          'a build-owner callback for rebuild or cold-cook',
          'connect the gateway to the project build owner before requesting a mutation',
          { requestId: operation.requestId, sourcePath: read.value.relative },
        ),
      );
    }
    if (!rebuilt.ok) return err(rebuilt.error);
    const refreshed = await readConfined(options, operation, operation.sourcePath);
    if (!refreshed.ok) return refreshed;
    const refreshedSnapshot = await createSnapshot(options, operation);
    if (!refreshedSnapshot.ok) return refreshedSnapshot;
    const selected = subjectFor(options.gameRoot, refreshedSnapshot.value, operation);
    if (!selected.ok) return selected;
    return inspectAfterWrite(
      operation,
      refreshed.value,
      refreshed.value.source,
      selected.value.packageId,
      {
        format: refreshed.value.relative.endsWith('.pack.json') ? 'pack.json' : 'pack.ts',
      },
    );
  }

  return err(
    makeError(
      'pack-parameter-invalid',
      'a supported Pack authoring operation',
      'use one of PACK_AUTHORING_OPERATION_IDS',
      { requestId: operation.requestId, operation: operation.operation },
    ),
  );
}

export function createFileSystemPackAuthoringPort(
  options: FileSystemPackAuthoringOptions,
): PackAuthoringGatewayPort<PackAuthoringOperationResult> {
  return { execute: (operation) => executeRaw(options, operation) };
}

export function createFileSystemPackAuthoringGateway(
  options: FileSystemPackAuthoringOptions,
): PackAuthoringGatewayPort<PackAuthoringOperationResult> {
  return createPackAuthoringGateway(createFileSystemPackAuthoringPort(options));
}
