import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parentPort, workerData } from 'node:worker_threads';
import ts from 'typescript';

if (parentPort === null) throw new Error('ScriptablePack worker requires a parent port');

const port = parentPort;
const workerMode = workerData as {
  readonly mode?: 'single' | 'reusable';
  readonly sourcePath?: string;
  readonly compileRoot?: string;
};
const reusable = workerMode.mode === 'reusable';
let sourcePath = workerMode.sourcePath;
let compileRoot = workerMode.compileRoot;
type LoadedDefinition = {
  readonly schemaVersion?: unknown;
  readonly packageId?: unknown;
  readonly name?: unknown;
  readonly parameters?: unknown;
  readonly sceneComponents?: unknown;
  readonly build?: unknown;
};
let definition: LoadedDefinition | undefined;
let nextReadId = 0;
const reads = new Map<number, (value: unknown) => void>();

function failure(error: unknown): unknown {
  if (error === null || typeof error !== 'object') return error;
  const value = error as Record<string, unknown>;
  return {
    name: value.name,
    code: value.code,
    expected: value.expected,
    actual: value.actual,
    hint: value.hint,
    detail: value.detail,
    message: value.message,
  };
}

function serializableSceneComponents(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  return value.map((component) => {
    const candidate = component as { readonly name?: unknown; readonly fields?: unknown };
    const fields =
      candidate.fields !== null &&
      typeof candidate.fields === 'object' &&
      !Array.isArray(candidate.fields)
        ? Object.fromEntries(
            Object.entries(candidate.fields as Record<string, unknown>).map(([name, field]) => [
              name,
              typeof field === 'string' ? field : (field as { readonly type?: unknown })?.type,
            ]),
          )
        : undefined;
    return { name: candidate.name, fields };
  });
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'] as const;

function resolveRelativeImport(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const raw = resolve(dirname(importer), specifier);
  const candidates =
    extname(raw).length > 0
      ? [raw]
      : [
          raw,
          ...SOURCE_EXTENSIONS.map((extension) => `${raw}${extension}`),
          resolve(raw, 'index.ts'),
        ];
  return candidates.find((candidate) => existsSync(candidate));
}

function outputName(path: string): string {
  const digest = createHash('sha256').update(path).digest('hex').slice(0, 20);
  return `${digest}.mjs`;
}

function resolveBareImport(importer: string, specifier: string): string | undefined {
  const resolver = (
    import.meta as ImportMeta & {
      readonly resolve?: (specifier: string, parent?: string) => string;
    }
  ).resolve;
  if (resolver === undefined) return undefined;
  // Resolve consumer dependencies from the source file first, then resolve
  // Engine self-references from this worker's package. A compiled source
  // closure lives in /tmp, so using only its path makes
  // @forgeax/engine-pack/source disappear from Node's lookup ancestry.
  for (const parent of [pathToFileURL(importer).href, import.meta.url]) {
    try {
      const resolved = resolver(specifier, parent);
      if (resolved.startsWith('file:')) return fileURLToPath(resolved);
    } catch {
      // Try the loader package before treating the import as unavailable.
    }
  }
  return undefined;
}

function resolvedModuleSpecifier(
  target: string,
  sources: ReadonlyMap<string, string>,
  loadId?: number,
): string {
  if (sources.has(target)) {
    return `./${outputName(target)}${loadId === undefined ? '' : `?load=${loadId}`}`;
  }
  return pathToFileURL(target).href;
}

/**
 * Node 22 does not execute `.ts` modules. Compile the trusted local module
 * closure into one disposable ESM directory before importing it. Bare package
 * imports are resolved by Node from the original source module and rewritten
 * to their canonical file URL; relative imports are rewritten to the compiled
 * closure by identity. This keeps unrelated nested node_modules directories
 * (for example Vite's cache) from changing package resolution.
 */
function compileModuleClosure(entryPath: string, outputRoot: string, loadId?: number): string {
  const pending = [resolve(entryPath)];
  const sources = new Map<string, string>();
  const imports = new Map<string, ReadonlyMap<string, string>>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (path === undefined || sources.has(path)) continue;
    const source = readFileSync(path, 'utf8');
    sources.set(path, source);
    const resolvedImports = new Map<string, string>();
    for (const imported of ts.preProcessFile(source, true, true).importedFiles) {
      const target = imported.fileName.startsWith('.')
        ? resolveRelativeImport(path, imported.fileName)
        : resolveBareImport(path, imported.fileName);
      if (target === undefined) continue;
      resolvedImports.set(imported.fileName, target);
      if (imported.fileName.startsWith('.') || /\.(?:ts|tsx|mts|cts)$/.test(target)) {
        pending.push(target);
      }
    }
    imports.set(path, resolvedImports);
  }

  for (const [path, source] of sources) {
    const replacements = imports.get(path) ?? new Map<string, string>();
    const rewriteRelativeImports: ts.TransformerFactory<ts.SourceFile> = (context) => {
      const visit: ts.Visitor = (node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier !== undefined &&
          ts.isStringLiteral(node.moduleSpecifier)
        ) {
          const target = replacements.get(node.moduleSpecifier.text);
          if (target !== undefined) {
            const moduleSpecifier = ts.factory.createStringLiteral(
              resolvedModuleSpecifier(target, sources, loadId),
            );
            return ts.isImportDeclaration(node)
              ? ts.factory.updateImportDeclaration(
                  node,
                  node.modifiers,
                  node.importClause,
                  moduleSpecifier,
                  node.attributes,
                )
              : ts.factory.updateExportDeclaration(
                  node,
                  node.modifiers,
                  node.isTypeOnly,
                  node.exportClause,
                  moduleSpecifier,
                  node.attributes,
                );
          }
        }
        if (
          ts.isCallExpression(node) &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          node.arguments[0] !== undefined &&
          ts.isStringLiteral(node.arguments[0])
        ) {
          const target = replacements.get(node.arguments[0].text);
          if (target !== undefined) {
            return ts.factory.updateCallExpression(node, node.expression, node.typeArguments, [
              ts.factory.createStringLiteral(resolvedModuleSpecifier(target, sources, loadId)),
            ]);
          }
        }
        return ts.visitEachChild(node, visit, context);
      };
      return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
    };
    const transpiled = ts.transpileModule(source, {
      fileName: path,
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        isolatedModules: true,
        sourceMap: false,
      },
      transformers: { before: [rewriteRelativeImports] },
      reportDiagnostics: true,
    });
    const errors =
      transpiled.diagnostics?.filter(
        (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
      ) ?? [];
    if (errors.length > 0) {
      throw new Error(
        `ScriptablePack TypeScript transpile failed for ${path}: ${errors
          .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
          .join('; ')}`,
      );
    }
    writeFileSync(join(outputRoot, outputName(path)), transpiled.outputText);
  }
  return join(outputRoot, outputName(resolve(entryPath)));
}

async function loadDefinition(task: {
  readonly sourcePath: string;
  readonly compileRoot: string;
  readonly loadId?: number;
}): Promise<void> {
  sourcePath = task.sourcePath;
  compileRoot = task.compileRoot;
  definition = undefined;
  reads.clear();
  const executablePath = SOURCE_EXTENSIONS.includes(
    extname(task.sourcePath) as (typeof SOURCE_EXTENSIONS)[number],
  )
    ? compileModuleClosure(task.sourcePath, task.compileRoot, task.loadId)
    : task.sourcePath;
  const loaded = (await import(
    `${pathToFileURL(executablePath).href}${reusable ? `?load=${task.loadId ?? 0}` : ''}`
  )) as {
    readonly default?: unknown;
  };
  definition = loaded.default as LoadedDefinition | undefined;
  port.postMessage({
    kind: 'loaded',
    ...(task.loadId === undefined ? {} : { loadId: task.loadId }),
    definition:
      definition === undefined
        ? undefined
        : {
            schemaVersion: definition.schemaVersion,
            packageId: definition.packageId,
            ...(definition.name === undefined ? {} : { name: definition.name }),
            ...(definition.parameters === undefined ? {} : { parameters: definition.parameters }),
            ...(definition.sceneComponents === undefined
              ? {}
              : { sceneComponents: serializableSceneComponents(definition.sceneComponents) }),
          },
  });
}

async function handleMessage(message: unknown): Promise<void> {
  if (message === null || typeof message !== 'object') return;
  const value = message as Record<string, unknown>;
  if (value.kind === 'asset-result' && typeof value.readId === 'number') {
    reads.get(value.readId)?.(value.result);
    reads.delete(value.readId);
    return;
  }
  if (
    reusable &&
    value.kind === 'load' &&
    typeof value.sourcePath === 'string' &&
    typeof value.compileRoot === 'string' &&
    typeof value.loadId === 'number'
  ) {
    try {
      await loadDefinition({
        sourcePath: value.sourcePath,
        compileRoot: value.compileRoot,
        loadId: value.loadId,
      });
    } catch (error) {
      port.postMessage({ kind: 'load-threw', loadId: value.loadId, error: failure(error) });
    }
    return;
  }
  if (value.kind !== 'build' || typeof value.buildId !== 'number') return;
  if (typeof definition?.build !== 'function') {
    port.postMessage({
      kind: 'build-result',
      buildId: value.buildId,
      result: { ok: false, error: { message: 'default export has no build function' } },
    });
    return;
  }
  try {
    const context =
      value.context !== null && typeof value.context === 'object'
        ? (value.context as { readonly packageId?: unknown; readonly values?: unknown })
        : undefined;
    const buildContext = {
      ...(Array.isArray(context?.packageId)
        ? { packageId: new Uint8Array(context.packageId as number[]) }
        : {}),
      ...(context?.values !== undefined ? { values: context.values } : {}),
      readByGuid(guid: Uint8Array): Promise<unknown> {
        const readId = nextReadId++;
        port.postMessage({ kind: 'asset-read', buildId: value.buildId, readId, guid });
        return new Promise((resolve) => reads.set(readId, resolve));
      },
    };
    const result = await definition.build(buildContext);
    port.postMessage({
      kind: 'build-result',
      buildId: value.buildId,
      result:
        result !== null && typeof result === 'object' && 'ok' in result && !result.ok
          ? { ...result, error: failure(result.error) }
          : result,
    });
  } catch (error) {
    port.postMessage({ kind: 'build-threw', buildId: value.buildId, error: failure(error) });
  }
}

port.on('message', (message: unknown) => {
  void handleMessage(message);
});

if (!reusable && sourcePath !== undefined && compileRoot !== undefined) {
  try {
    await loadDefinition({ sourcePath, compileRoot });
  } catch (error) {
    port.postMessage({ kind: 'load-threw', error: failure(error) });
  }
}
