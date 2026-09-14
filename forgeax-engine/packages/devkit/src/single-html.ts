import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type DefaultTreeAdapterTypes, parse } from 'parse5';
import { type Plugin, parseAst, Visitor, build as viteBuild } from 'vite';
import { type DistArtifact, type DistManifest, mediaType } from './dist.js';
import { createEngineWorkspaceResolverForProject } from './host.js';
import type { CommandError, CommandResult } from './types.js';

const SINGLE_HTML_FORMAT = 'forgeax-single-html-game' as const;
const GENERATED_PREFIX = '__forgeax-bundle/';

export interface SingleHtmlBundleArtifact {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}

export interface SingleHtmlBundle {
  readonly entrySource: string;
  readonly artifacts: readonly SingleHtmlBundleArtifact[];
}

export interface SingleHtmlPackageOptions {
  readonly distRoot: string;
  readonly output: string;
  readonly manifest: DistManifest;
  readonly bundle: SingleHtmlBundle;
}

export interface SingleHtmlPackageResult {
  readonly schemaVersion: '1.0.0';
  readonly format: typeof SINGLE_HTML_FORMAT;
  readonly target: 'file';
  readonly project: DistManifest['project'];
  readonly base: DistManifest['base'];
  readonly html: { readonly path: string; readonly bytes: number; readonly sha256: string };
  readonly checksumPath: string;
  readonly distManifestSha256: string;
  readonly embeddedAssets: number;
  readonly run: {
    readonly local: string;
    readonly shared: string;
  };
}

class SingleHtmlError extends Error implements CommandError {
  constructor(
    readonly code: string,
    readonly expected: string,
    readonly hint: string,
    readonly detail: Readonly<Record<string, unknown>>,
  ) {
    super(`${code}: ${hint}`);
    this.name = 'SingleHtmlError';
  }
}

function errorResult(
  code: string,
  expected: string,
  hint: string,
  detail: Readonly<Record<string, unknown>> = {},
): CommandResult<never> {
  return { ok: false, error: new SingleHtmlError(code, expected, hint, detail) };
}

function toErrorResult(
  cause: unknown,
  code: string,
  expected: string,
  hint: string,
): CommandResult<never> {
  if (cause instanceof SingleHtmlError) return { ok: false, error: cause };
  return errorResult(code, expected, hint, {
    reason: cause instanceof Error ? cause.message : String(cause),
  });
}

function normalizePath(value: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? value);
  } catch {
    return undefined;
  }
  const normalized = decoded.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (
    normalized.length === 0 ||
    segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return normalized;
}

function safeScriptText(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

function hashBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function contentTypeForDataUri(value: string): string {
  const semicolon = value.indexOf(';');
  return semicolon < 0 ? value : value.slice(0, semicolon);
}

function dataUri(bytes: Uint8Array, type: string): string {
  return `data:${contentTypeForDataUri(type)};base64,${Buffer.from(bytes).toString('base64')}`;
}

interface HtmlElement {
  readonly name: string;
  readonly start: number;
  readonly openEnd: number;
  readonly end: number;
  readonly contentStart?: number;
  readonly contentEnd?: number;
  readonly attributes: readonly { readonly name: string; readonly value: string }[];
  readonly attributeLocations: Readonly<
    Record<string, { readonly startOffset: number; readonly endOffset: number }>
  >;
}

interface Replacement {
  readonly start: number;
  readonly end: number;
  readonly value: string;
}

type ParsedElement = DefaultTreeAdapterTypes.Element;
type ParsedNode = DefaultTreeAdapterTypes.Node;

function attributeValueRange(
  source: string,
  location: { readonly startOffset: number; readonly endOffset: number },
): { readonly startOffset: number; readonly endOffset: number } | undefined {
  const raw = source.slice(location.startOffset, location.endOffset);
  const equals = raw.indexOf('=');
  if (equals < 0) return undefined;
  let cursor = equals + 1;
  while (/\s/.test(raw[cursor] ?? '')) cursor += 1;
  const quote = raw[cursor] === '"' || raw[cursor] === "'" ? raw[cursor] : undefined;
  if (quote !== undefined) {
    const start = cursor + 1;
    const end = raw.lastIndexOf(quote);
    return end <= start
      ? undefined
      : { startOffset: location.startOffset + start, endOffset: location.startOffset + end };
  }
  return {
    startOffset: location.startOffset + cursor,
    endOffset: location.endOffset,
  };
}

function scanHtmlElements(source: string): readonly HtmlElement[] {
  const document = parse(source, { sourceCodeLocationInfo: true });
  const elements: HtmlElement[] = [];
  const visit = (node: ParsedNode): void => {
    if (node.nodeName === '#document' || node.nodeName === '#document-fragment') {
      for (const child of node.childNodes) visit(child);
      return;
    }
    if (
      node.nodeName === '#text' ||
      node.nodeName === '#comment' ||
      node.nodeName === '#documentType'
    ) {
      return;
    }
    const element = node as ParsedElement;
    const location = element.sourceCodeLocation;
    if (location?.startTag === undefined) {
      for (const child of element.childNodes) visit(child);
      return;
    }
    const name = element.tagName.toLowerCase();
    const attributes = element.attrs.map(({ name: attributeName, value }) => ({
      name: attributeName.toLowerCase(),
      value,
    }));
    const attributeLocations: Record<
      string,
      { readonly startOffset: number; readonly endOffset: number }
    > = {};
    for (const attribute of attributes) {
      const attributeLocation = location.attrs?.[attribute.name];
      if (attributeLocation !== undefined) attributeLocations[attribute.name] = attributeLocation;
    }
    elements.push({
      name,
      start: location.startTag.startOffset,
      openEnd: location.startTag.endOffset,
      end: location.endTag?.endOffset ?? location.startTag.endOffset,
      ...(name === 'script' || name === 'style'
        ? {
            contentStart: location.startTag.endOffset,
            contentEnd: location.endTag?.startOffset ?? location.startTag.endOffset,
          }
        : {}),
      attributes,
      attributeLocations,
    });
    for (const child of element.childNodes) visit(child);
  };
  visit(document);
  return elements;
}

function attribute(
  element: HtmlElement,
  name: string,
): { readonly name: string; readonly value: string } | undefined {
  return element.attributes.find((candidate) => candidate.name === name);
}

function attributeValue(element: HtmlElement, name: string): string | undefined {
  return attribute(element, name)?.value;
}

function isModuleScript(element: HtmlElement): boolean {
  return element.name === 'script' && attributeValue(element, 'type')?.toLowerCase() === 'module';
}

function isStylesheet(element: HtmlElement): boolean {
  return (
    element.name === 'link' &&
    attributeValue(element, 'rel')?.toLowerCase().split(/\s+/).includes('stylesheet') === true
  );
}

function isModulePreload(element: HtmlElement): boolean {
  return (
    element.name === 'link' &&
    attributeValue(element, 'rel')?.toLowerCase().split(/\s+/).includes('modulepreload') === true
  );
}

function resourceForPath(
  path: string,
  resources: ReadonlyMap<string, SingleHtmlBundleArtifact>,
): SingleHtmlBundleArtifact | undefined {
  const normalized = normalizePath(path);
  if (normalized === undefined) return undefined;
  const direct = resources.get(normalized);
  if (direct !== undefined) return direct;
  const suffix = [...resources.entries()].filter(([candidate]) =>
    candidate.endsWith(`/${normalized}`),
  );
  return suffix.length === 1 ? suffix[0]?.[1] : undefined;
}

function resourcePath(reference: string, basePath: string): string | undefined {
  try {
    return normalizePath(new URL(reference, `https://forgeax.invalid/${basePath}`).pathname);
  } catch {
    return undefined;
  }
}

function applyReplacements(source: string, replacements: readonly Replacement[]): string {
  const unique = new Map<string, Replacement>();
  for (const replacement of replacements) {
    unique.set(`${replacement.start}:${replacement.end}`, replacement);
  }
  const ordered = [...unique.values()].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous !== undefined && current !== undefined && previous.end > current.start) {
      throw new Error(
        `single-html AST replacements overlap (${previous.start}:${previous.end} and ${current.start}:${current.end})`,
      );
    }
  }
  return ordered
    .reverse()
    .reduce(
      (value, replacement) =>
        value.slice(0, replacement.start) + replacement.value + value.slice(replacement.end),
      source,
    );
}

function inlineCss(
  css: string,
  cssPath: string,
  resources: ReadonlyMap<string, SingleHtmlBundleArtifact>,
): CommandResult<string> {
  const replacements: Replacement[] = [];
  const pattern = /url\(\s*(["']?)(.*?)\1\s*\)/gi;
  for (;;) {
    const match = pattern.exec(css);
    if (match === null) break;
    const reference = match[2]?.trim();
    if (
      reference === undefined ||
      reference.length === 0 ||
      reference.startsWith('data:') ||
      reference.startsWith('#')
    ) {
      continue;
    }
    if (/^(?:https?:|blob:)/i.test(reference)) {
      return errorResult(
        'single-html-css-external-resource',
        'CSS URL references to be embedded or data/blob URLs',
        'Move the CSS resource into the verified dist closure before packaging.',
        { cssPath, reference },
      );
    }
    const path = resourcePath(reference, cssPath);
    const resource = path === undefined ? undefined : resourceForPath(path, resources);
    if (resource === undefined) {
      return errorResult(
        'single-html-css-asset-missing',
        'every local CSS URL to resolve to an embedded dist artifact',
        'Add the referenced asset to the project asset closure and rebuild.',
        { cssPath, reference, path: path ?? null },
      );
    }
    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      value: `url(${dataUri(resource.bytes, resource.mediaType)})`,
    });
  }
  return { ok: true, value: applyReplacements(css, replacements) };
}

function collectEntrySource(html: string): CommandResult<string> {
  const entries = scanHtmlElements(html).filter((element) => isModuleScript(element));
  const external = entries.filter((element) => attributeValue(element, 'src') !== undefined);
  const inline = entries.filter((element) => attributeValue(element, 'src') === undefined);
  if (external.length === 0 && inline.length === 0) {
    return errorResult(
      'single-html-entry-missing',
      'production index.html to contain one module entry',
      'Rebuild the game with a module entry in its generated host.',
    );
  }
  if (external.length > 1 || inline.length > 1) {
    return errorResult(
      'single-html-entry-ambiguous',
      'production index.html to contain exactly one module entry',
      'Converge the generated host to one ForgeaX module entry before packaging.',
      { external: external.length, inline: inline.length },
    );
  }
  const element = external[0] ?? inline[0];
  if (element === undefined) throw new Error('single-html entry selection was unexpectedly empty');
  const src = attributeValue(element, 'src');
  if (src === undefined && element.contentStart !== undefined && element.contentEnd !== undefined) {
    return { ok: true, value: html.slice(element.contentStart, element.contentEnd) };
  }
  if (src === undefined) {
    return errorResult(
      'single-html-entry-missing',
      'a module entry source',
      'Add a module entry to index.html.',
    );
  }
  if (/^(?:https?:|file:|data:|blob:)/i.test(src)) {
    return errorResult(
      'single-html-entry-external',
      'the module entry to be a project-local dist artifact',
      'Rebuild the game so the generated host points at a local production module.',
      { src },
    );
  }
  return { ok: true, value: src };
}

async function filesUnder(root: string, directory = root): Promise<string[]> {
  const result: string[] = [];
  for (const name of (await readdir(directory)).sort()) {
    const path = resolve(directory, name);
    const info = await stat(path);
    if (info.isDirectory()) result.push(...(await filesUnder(root, path)));
    else if (info.isFile()) result.push(path);
  }
  return result;
}

function isPreloadHelperSource(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const path = value.split(/[?#]/, 1)[0] ?? value;
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.startsWith('preload-helper-') && name.endsWith('.js');
}

function isStaticImportSource(source: {
  readonly type?: string;
  readonly expressions?: readonly unknown[];
}): boolean {
  return (
    source.type === 'Literal' ||
    source.type === 'StringLiteral' ||
    (source.type === 'TemplateLiteral' && source.expressions?.length === 0)
  );
}

type SingleHtmlProgram = ReturnType<typeof parseAst>;

interface SingleHtmlMagicString {
  overwrite(start: number, end: number, content: string): SingleHtmlMagicString;
  hasChanged(): boolean;
}

interface SingleHtmlTransformMeta {
  readonly ast?: SingleHtmlProgram;
  readonly magicString?: SingleHtmlMagicString;
}

interface SingleHtmlPluginContext {
  error(message: string): never;
}

interface SingleHtmlOutputChunk {
  type: 'chunk';
  fileName: string;
  code: string;
}

interface SingleHtmlOutputAsset {
  type: 'asset';
  fileName: string;
  source?: string | Uint8Array;
}

type SingleHtmlOutputBundle = Record<string, SingleHtmlOutputChunk | SingleHtmlOutputAsset>;

function programReplacements(program: SingleHtmlProgram): readonly Replacement[] {
  const replacements: Replacement[] = [];
  const preloadBindings = new Set<string>();
  new Visitor({
    ImportDeclaration(node) {
      if (!isPreloadHelperSource(node.source.value)) return;
      for (const specifier of node.specifiers) {
        if (specifier.type === 'ImportSpecifier') preloadBindings.add(specifier.local.name);
      }
    },
    CallExpression(node) {
      if (
        node.callee.type !== 'Identifier' ||
        !preloadBindings.has(node.callee.name) ||
        node.arguments.length < 2
      ) {
        return;
      }
      const dependencies = node.arguments[1];
      if (dependencies !== undefined) {
        replacements.push({ start: dependencies.start, end: dependencies.end, value: 'void 0' });
      }
    },
    ImportExpression(node) {
      if (isStaticImportSource(node.source)) return;
      replacements.push({
        start: node.start,
        end: node.start + 'import'.length,
        value: 'globalThis.__forgeaxImport',
      });
    },
  }).visit(program);
  return replacements;
}

function outputReplacements(program: SingleHtmlProgram): readonly Replacement[] {
  const replacements: Replacement[] = [];
  new Visitor({
    ImportExpression(node) {
      replacements.push({
        start: node.start,
        end: node.start + 'import'.length,
        value: 'globalThis.__forgeaxImport',
      });
    },
  }).visit(program);
  return replacements;
}

function rewriteOutputJavaScript(code: string): string {
  const program = parseAst(code);
  return applyReplacements(code, outputReplacements(program));
}

function residualImportStart(code: string): number | undefined {
  let residualStart: number | undefined;
  new Visitor({
    ImportExpression(node) {
      residualStart ??= node.start;
    },
  }).visit(parseAst(code));
  return residualStart;
}

function isJavaScriptOutputAsset(fileName: string): boolean {
  return /\.(?:c?js|mjs)$/i.test(fileName);
}

function singleHtmlBundlePlugin(): Plugin {
  const plugin = {
    name: 'forgeax-single-html-bundle-runtime',
    enforce: 'post',
    transform: {
      order: 'post',
      handler(
        this: SingleHtmlPluginContext,
        code: string,
        _id: string,
        meta?: SingleHtmlTransformMeta,
      ) {
        let program = meta?.ast;
        if (program === undefined) {
          try {
            program = parseAst(code);
          } catch {
            return null;
          }
        }
        const replacements = programReplacements(program);
        if (replacements.length === 0) return null;
        if (meta?.magicString !== undefined) {
          for (const replacement of replacements) {
            meta.magicString.overwrite(replacement.start, replacement.end, replacement.value);
          }
          return meta.magicString.hasChanged() ? meta.magicString : null;
        }
        return applyReplacements(code, replacements);
      },
    },
    generateBundle(
      this: SingleHtmlPluginContext,
      _outputOptions: unknown,
      bundle: SingleHtmlOutputBundle,
    ) {
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk') {
          output.code = rewriteOutputJavaScript(output.code);
        } else if (isJavaScriptOutputAsset(output.fileName) && output.source !== undefined) {
          const source =
            typeof output.source === 'string'
              ? output.source
              : Buffer.from(output.source).toString('utf8');
          output.source = rewriteOutputJavaScript(source);
        } else {
          continue;
        }
        const code = output.type === 'chunk' ? output.code : String(output.source);
        const residualStart = residualImportStart(code);
        if (residualStart !== undefined) {
          this.error(
            `single-html bundle left a native dynamic import in ${output.fileName} at ${residualStart}`,
          );
        }
      }
    },
    resolveFileUrl: ({ fileName }: { readonly fileName: string }) =>
      JSON.stringify(`${GENERATED_PREFIX}${fileName}`),
  } as unknown as Plugin;
  return plugin;
}

export async function bundleSingleHtmlEntry(
  distRootInput: string,
  indexHtml: string,
  projectRoot?: string,
): Promise<CommandResult<SingleHtmlBundle>> {
  const distRoot = resolve(distRootInput);
  const selected = collectEntrySource(indexHtml);
  if (!selected.ok) return selected;
  const source = selected.value;
  const entryPath = normalizePath(source);
  const temporaryRoot = await mkdtemp(resolve(tmpdir(), 'forgeax-single-html-bundle-'));
  try {
    let inputPath: string | undefined;
    if (entryPath !== undefined) {
      const candidate = resolve(distRoot, entryPath);
      try {
        const candidateInfo = await stat(candidate);
        if (candidateInfo.isFile()) inputPath = candidate;
      } catch {
        // A missing path is reported by Vite below as a bundle failure; keep
        // inline source handling deterministic rather than guessing from text.
      }
    }
    if (inputPath === undefined) {
      inputPath = resolve(temporaryRoot, 'inline-entry.mjs');
      await writeFile(inputPath, source, 'utf8');
    }
    const outputRoot = resolve(temporaryRoot, 'dist');
    const resolver: Plugin | undefined =
      projectRoot === undefined
        ? undefined
        : await createEngineWorkspaceResolverForProject(projectRoot);
    await viteBuild({
      configFile: false,
      root: distRoot,
      base: './',
      logLevel: 'error',
      plugins: [singleHtmlBundlePlugin(), ...(resolver === undefined ? [] : [resolver])],
      experimental: {
        renderBuiltUrl: (filename: string) => `forgeax-resource:///${GENERATED_PREFIX}${filename}`,
      },
      build: {
        outDir: outputRoot,
        emptyOutDir: true,
        target: 'esnext',
        minify: false,
        sourcemap: false,
        assetsInlineLimit: 0,
        modulePreload: false,
        rolldownOptions: {
          input: inputPath,
          output: {
            codeSplitting: false,
            entryFileNames: 'entry.mjs',
            chunkFileNames: 'assets/[name]-[hash].mjs',
            assetFileNames: 'assets/[name]-[hash][extname]',
          },
          experimental: { nativeMagicString: true },
        },
      },
    });
    const paths = (await filesUnder(outputRoot)).map((path) =>
      relative(outputRoot, path).split(sep).join('/'),
    );
    const entry = paths.find((path) => path === 'entry.mjs');
    if (entry === undefined) {
      return errorResult(
        'single-html-bundle-entry-missing',
        'Vite to emit exactly one entry.mjs',
        'Inspect the production entry and the single-html bundler output.',
        { outputRoot, paths },
      );
    }
    const generatedPaths = paths.filter((path) => path !== entry);
    const artifacts: SingleHtmlBundleArtifact[] = [];
    for (const path of generatedPaths) {
      const bytes = await readFile(resolve(outputRoot, path));
      artifacts.push({
        path: `${GENERATED_PREFIX}${path}`,
        bytes,
        mediaType: mediaType(path),
      });
    }
    const entryBytes = await readFile(resolve(outputRoot, entry));
    return {
      ok: true,
      value: {
        entrySource: entryBytes.toString('utf8'),
        artifacts,
      },
    };
  } catch (cause) {
    return toErrorResult(
      cause,
      'single-html-bundle-failed',
      'the production module entry to converge into one executable bundle',
      'Repair the production entry or inspect the Vite/Rolldown diagnostic before packaging.',
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

function workerPrelude(resources: readonly SingleHtmlBundleArtifact[]): string {
  const payload = resources.map((resource) => ({
    path: resource.path,
    mime: resource.mediaType,
    data: Buffer.from(resource.bytes).toString('base64'),
  }));
  const template = `globalThis.process??={env:{},versions:{node:'0.0.0'},platform:'browser',argv:[]};
const __forgeaxWorkerPayload=${JSON.stringify(payload)};
const __forgeaxSourcePath=__FORGEAX_SOURCE_PATH__;
const __forgeaxNativeURL=globalThis.URL;
const __forgeaxNativeFetch=globalThis.fetch?.bind(globalThis);
const __forgeaxNativePostMessage=globalThis.postMessage?.bind(globalThis);
const __forgeaxOwnedUrls=new Set();
const __forgeaxBytes=(value)=>{const binary=atob(value);const bytes=new Uint8Array(binary.length);for(let index=0;index<binary.length;index+=1)bytes[index]=binary.charCodeAt(index);return bytes;};
const __forgeaxDataURL=(source)=>{const bytes=new TextEncoder().encode(source);let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);return 'data:text/javascript;base64,'+btoa(binary);};
const __forgeaxWorkerURL=(source)=>{if(/^(?:file:|data:|about:)/i.test(String(globalThis.location?.protocol??'')))return __forgeaxDataURL(source);const blob=__forgeaxNativeURL.createObjectURL(new Blob([source],{type:'text/javascript'}));__forgeaxOwnedUrls.add(blob);return blob;};
const __forgeaxNormalize=(value)=>{try{return decodeURIComponent(String(value).split(/[?#]/,1)[0]).replaceAll('\\\\','/').replace(/^\\/+/, '');}catch{return undefined;}};
const __forgeaxWithoutBundle=(value)=>String(value).replace(/^__forgeax-bundle\\//,'');
const __forgeaxLookup=(value)=>{let url;try{url=value instanceof __forgeaxNativeURL?value:new __forgeaxNativeURL(String(value),'https://forgeax.invalid/'+__forgeaxSourcePath);}catch{return undefined;}const path=__forgeaxNormalize(url.pathname);if(path===undefined)return undefined;const normalized=__forgeaxWithoutBundle(path);const exact=__forgeaxWorkerPayload.find((entry)=>entry.path===path||__forgeaxWithoutBundle(entry.path)===normalized);if(exact!==undefined)return exact;const suffix=__forgeaxWorkerPayload.filter((entry)=>normalized.endsWith('/'+__forgeaxWithoutBundle(entry.path)));if(suffix.length===1)return suffix[0];const name=normalized.slice(normalized.lastIndexOf('/')+1);const matches=__forgeaxWorkerPayload.filter((entry)=>__forgeaxWithoutBundle(entry.path).slice(__forgeaxWithoutBundle(entry.path).lastIndexOf('/')+1)===name);return matches.length===1?matches[0]:undefined;};
const __forgeaxResourceURL=(value)=>{const raw=String(value);try{const url=new __forgeaxNativeURL(raw,'https://forgeax.invalid/'+__forgeaxSourcePath);if(url.protocol!=='http:'&&url.protocol!=='https:')return url;const path=__forgeaxNormalize(url.pathname);return path===undefined?url:new __forgeaxNativeURL('forgeax-resource:///'+__forgeaxWithoutBundle(path));}catch{return new __forgeaxNativeURL(raw,'https://forgeax.invalid/'+__forgeaxSourcePath);}};
globalThis.__forgeaxURL=__forgeaxResourceURL;
class __ForgeaxURL extends __forgeaxNativeURL{constructor(input,base){if(base!==undefined&&/^blob:/i.test(String(base))&&!/^[a-z][a-z0-9+.-]*:/i.test(String(input))){super(__forgeaxResourceURL(input));return;}super(input,base);}}
globalThis.URL=__ForgeaxURL;
const __forgeaxNote=(kind,specifier)=>{const value={kind,specifier:String(specifier)};try{__forgeaxNativePostMessage?.({__forgeaxResourceMiss:value});}catch{}};
const __forgeaxNoteHit=()=>{try{__forgeaxNativePostMessage?.({__forgeaxResourceHit:1});}catch{}};
const __forgeaxNoteExternal=(kind,specifier)=>{const value={kind,specifier:String(specifier)};try{__forgeaxNativePostMessage?.({__forgeaxExternalRequest:value});}catch{}};
const __forgeaxResponse=(entry)=>{__forgeaxNoteHit();return new Response(__forgeaxBytes(entry.data),{status:200,headers:{'Content-Type':entry.mime}});};
const __forgeaxImportUrls=new Map();
const __forgeaxImport=async(value)=>{const entry=__forgeaxLookup(value);if(entry===undefined){__forgeaxNote('import',value);throw new TypeError('forgeax single-html worker resource miss');}let url=__forgeaxImportUrls.get(entry.path);if(url===undefined){url=__forgeaxNativeURL.createObjectURL(new Blob([__forgeaxBytes(entry.data)],{type:'text/javascript'}));__forgeaxOwnedUrls.add(url);__forgeaxImportUrls.set(entry.path,url);}__forgeaxNoteHit();return import(url);};
globalThis.__forgeaxImport=__forgeaxImport;
if(typeof __forgeaxNativeFetch==='function')globalThis.fetch=(input,init)=>{const entry=__forgeaxLookup(input);if(entry!==undefined)return Promise.resolve(__forgeaxResponse(entry));const text=String(input);if(/^(?:data:|blob:)/i.test(text))return __forgeaxNativeFetch(input,init);if(/^https?:/i.test(text)){__forgeaxNoteExternal('fetch',input);}else{__forgeaxNote('fetch',input);}return Promise.reject(new TypeError('forgeax single-html worker resource miss'));};
const __forgeaxWorkerPrelude=__FORGEAX_WORKER_FACTORY__;
const __forgeaxNativeWorker=globalThis.Worker;
if(typeof __forgeaxNativeWorker==='function')globalThis.Worker=class extends __forgeaxNativeWorker{constructor(input,options){const entry=__forgeaxLookup(input);if(entry===undefined){__forgeaxNote('worker',input);throw new TypeError('forgeax single-html worker resource miss');}const source=new TextDecoder().decode(__forgeaxBytes(entry.data));super(__forgeaxWorkerURL(__forgeaxWorkerPrelude(entry.path)+source),options);}};
globalThis.addEventListener?.('message',(event)=>{if(event.data?.__forgeaxResourceMiss||event.data?.__forgeaxResourceHit||event.data?.__forgeaxExternalRequest){try{__forgeaxNativePostMessage?.(event.data);}catch{}event.stopImmediatePropagation?.();}});
globalThis.addEventListener?.('unload',()=>{for(const url of __forgeaxOwnedUrls)__forgeaxNativeURL.revokeObjectURL(url);__forgeaxOwnedUrls.clear();});`;
  // The factory is copied into every worker prelude so nested workers keep the
  // same complete resource table and can recursively create their own prelude.
  // It is self-referential by source text rather than by a host-side closure:
  // workers are independent realms and cannot capture this function.
  const factoryToken = '__FORGEAX_WORKER_FACTORY__';
  const recursiveTemplate = template;
  const factorySource = `(sourcePath)=>{const source=${JSON.stringify(recursiveTemplate)};return source.replace(${JSON.stringify(factoryToken)},()=> '('+__forgeaxWorkerPrelude.toString()+')').replace('__FORGEAX_SOURCE_PATH__',()=>JSON.stringify(sourcePath));}`;
  return `const __forgeaxWorkerPrelude=${factorySource};`;
}

function runtimeBootstrap(resources: readonly SingleHtmlBundleArtifact[]): string {
  const workerFactory = workerPrelude(resources);
  return `(() => {
  globalThis.process ??= { env: {}, versions: { node: '0.0.0' }, platform: 'browser', argv: [] };
  const nativeURL = globalThis.URL;
  const nativeFetch = globalThis.fetch?.bind(globalThis);
  const nodes = [...document.querySelectorAll('script[data-forgeax-asset]')];
  const entries = nodes.map((node) => ({ path: node.getAttribute('data-path'), mime: node.getAttribute('data-mime') || 'application/octet-stream', data: (node.textContent || '').trim() })).filter((entry) => typeof entry.path === 'string');
  const decode = (value) => { const binary = atob(value); const bytes = new Uint8Array(binary.length); for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index); return bytes; };
  const normalize = (value) => { try { return decodeURIComponent(String(value).split(/[?#]/, 1)[0]).replaceAll('\\\\', '/').replace(/^\\/+/, ''); } catch { return undefined; } };
  const withoutBundle = (value) => String(value).replace(/^__forgeax-bundle\\//, '');
  const lookup = (input) => { let url; try { url = input instanceof nativeURL ? input : new nativeURL(String(input), document.baseURI); } catch { return undefined; } if (url.protocol === 'data:' || url.protocol === 'blob:') return undefined; const path = normalize(url.pathname); if (path === undefined) return undefined; const normalized = withoutBundle(path); const exact = entries.find((entry) => entry.path === path || withoutBundle(entry.path) === normalized); if (exact !== undefined) return exact; const suffix = entries.filter((entry) => normalized.endsWith('/' + withoutBundle(entry.path))); if (suffix.length === 1) return suffix[0]; const name = normalized.slice(normalized.lastIndexOf('/') + 1); const matches = entries.filter((entry) => withoutBundle(entry.path).slice(withoutBundle(entry.path).lastIndexOf('/') + 1) === name); return matches.length === 1 ? matches[0] : undefined; };
  const resourceMisses = [];
  const externalRequests = [];
  let resourceHits = 0;
  const noteMiss = (kind, specifier) => { resourceMisses.push({ kind, specifier: String(specifier), realm: 'main' }); };
  const noteExternal = (kind, specifier) => { externalRequests.push({ kind, specifier: String(specifier), realm: 'main' }); };
  const response = (entry) => { resourceHits += 1; return new Response(decode(entry.data), { status: 200, headers: { 'Content-Type': entry.mime } }); };
  const ownedBlobUrls = new Set();
  const makeBlobUrl = (entry) => { const url = nativeURL.createObjectURL(new Blob([decode(entry.data)], { type: entry.mime })); ownedBlobUrls.add(url); return url; };
  const dataUrl = (source) => { const bytes = new TextEncoder().encode(source); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return 'data:text/javascript;base64,' + btoa(binary); };
  const workerUrl = (source) => { if (/^(?:file:|data:|about:)/i.test(String(globalThis.location?.protocol ?? ''))) return dataUrl(source); const url = nativeURL.createObjectURL(new Blob([source], { type: 'text/javascript' })); ownedBlobUrls.add(url); return url; };
  const importUrls = new Map();
  const forgeaxImport = async (specifier) => { const entry = lookup(specifier); if (entry === undefined) { const text = String(specifier); if (/^(?:https?:)/i.test(text)) noteExternal('import', text); else noteMiss('import', text); throw new TypeError('forgeax single-html resource miss'); } let url = importUrls.get(entry.path); if (url === undefined) { url = makeBlobUrl(entry); importUrls.set(entry.path, url); } resourceHits += 1; return import(url); };
  globalThis.__forgeaxImport = forgeaxImport;
  const external = (input) => { try { const url = input instanceof nativeURL ? input : new nativeURL(String(input), document.baseURI); return url.protocol === 'http:' || url.protocol === 'https:'; } catch { return false; } };
  if (typeof nativeFetch === 'function') globalThis.fetch = (input, init) => { const entry = lookup(input); if (entry !== undefined) return Promise.resolve(response(entry)); if (/^(?:data:|blob:)/i.test(String(input))) return nativeFetch(input, init); if (external(input)) { noteExternal('fetch', input); return Promise.reject(new TypeError('forgeax single-html blocked an external request')); } noteMiss('fetch', input); return Promise.reject(new TypeError('forgeax single-html resource miss')); };
  ${workerFactory}
  const nativeWorker = globalThis.Worker;
  const attachWorker = (worker) => { worker.addEventListener('message', (event) => { const miss = event.data?.__forgeaxResourceMiss; if (miss !== undefined) { resourceMisses.push({ ...miss, realm: 'worker' }); event.stopImmediatePropagation?.(); } const externalRequest = event.data?.__forgeaxExternalRequest; if (externalRequest !== undefined) { externalRequests.push({ ...externalRequest, realm: 'worker' }); event.stopImmediatePropagation?.(); } const hit = event.data?.__forgeaxResourceHit; if (typeof hit === 'number' && Number.isFinite(hit)) resourceHits += hit; }); return worker; };
  if (typeof nativeWorker === 'function') globalThis.Worker = class extends nativeWorker { constructor(input, options) { const entry = lookup(input); if (entry === undefined) { const text = String(input); if (external(input)) noteExternal('worker', text); else noteMiss('worker', text); throw new TypeError('forgeax single-html worker resource miss'); } const source = new TextDecoder().decode(decode(entry.data)); super(workerUrl(__forgeaxWorkerPrelude(entry.path) + source), options); attachWorker(this); } };
  const witness = () => ({ ready: document.documentElement.dataset.forgeaxSingleHtmlReady === 'true', resourceHits, resourceMisses: resourceMisses.slice(), externalRequests: externalRequests.slice() });
  globalThis.__forgeaxSingleHtml = { lookup, entries: entries.map(({ path, mime }) => ({ path, mime })), witness };
  globalThis.addEventListener('pagehide', () => { for (const url of ownedBlobUrls) nativeURL.revokeObjectURL(url); ownedBlobUrls.clear(); }, { once: true });
  document.documentElement.dataset.forgeaxSingleHtmlReady = 'true';
})();`;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function distResources(
  distRoot: string,
  manifest: DistManifest,
): Promise<SingleHtmlBundleArtifact[]> {
  const rows: readonly (DistArtifact | { readonly path: string })[] = [
    ...manifest.artifacts,
    { path: 'forgeax-dist.json' },
  ];
  return Promise.all(
    rows
      .filter((artifact) => artifact.path !== 'index.html')
      .map(async (artifact) => ({
        path: artifact.path,
        bytes: await readFile(resolve(distRoot, artifact.path)),
        mediaType: 'mediaType' in artifact ? artifact.mediaType : mediaType(artifact.path),
      })),
  );
}

function buildHtml(
  indexHtml: string,
  distArtifacts: readonly SingleHtmlBundleArtifact[],
  bundle: SingleHtmlBundle,
): CommandResult<{ readonly html: string; readonly embeddedAssets: number }> {
  const resources = new Map<string, SingleHtmlBundleArtifact>();
  for (const resource of [...distArtifacts, ...bundle.artifacts]) {
    if (resources.has(resource.path)) {
      return errorResult(
        'single-html-asset-duplicate',
        'embedded resource paths to be unique',
        'Repair the generated bundle path collision before packaging.',
        { path: resource.path },
      );
    }
    resources.set(resource.path, resource);
  }

  const replacements: Replacement[] = [];
  for (const element of scanHtmlElements(indexHtml)) {
    if (isModuleScript(element) || isModulePreload(element)) {
      replacements.push({ start: element.start, end: element.end, value: '' });
      continue;
    }
    if (isStylesheet(element)) {
      const href = attributeValue(element, 'href');
      if (href === undefined) {
        return errorResult(
          'single-html-stylesheet-missing',
          'stylesheet link to contain href',
          'Repair the generated HTML stylesheet link.',
        );
      }
      const path = resourcePath(href, 'index.html');
      const stylesheet = path === undefined ? undefined : resourceForPath(path, resources);
      if (stylesheet === undefined) {
        return errorResult(
          'single-html-css-asset-missing',
          'stylesheet link to resolve to an embedded artifact',
          'Add the stylesheet to the dist closure and rebuild.',
          { href, path: path ?? null },
        );
      }
      const css = inlineCss(
        Buffer.from(stylesheet.bytes).toString('utf8'),
        stylesheet.path,
        resources,
      );
      if (!css.ok) return css;
      replacements.push({
        start: element.start,
        end: element.end,
        value: `<style data-forgeax-inline-css>${css.value}</style>`,
      });
      continue;
    }
    if (
      element.name === 'style' &&
      element.contentStart !== undefined &&
      element.contentEnd !== undefined
    ) {
      const css = inlineCss(
        indexHtml.slice(element.contentStart, element.contentEnd),
        'index.html',
        resources,
      );
      if (!css.ok) return css;
      replacements.push({ start: element.contentStart, end: element.contentEnd, value: css.value });
      continue;
    }
    const resourceAttribute =
      element.name === 'img' ||
      element.name === 'source' ||
      element.name === 'video' ||
      element.name === 'audio' ||
      element.name === 'link'
        ? element.attributes.find((candidate) => ['src', 'poster', 'href'].includes(candidate.name))
        : undefined;
    const resourceAttributeLocation =
      resourceAttribute === undefined
        ? undefined
        : element.attributeLocations[resourceAttribute.name];
    const resourceAttributeRange =
      resourceAttribute === undefined || resourceAttributeLocation === undefined
        ? undefined
        : attributeValueRange(indexHtml, resourceAttributeLocation);
    if (
      resourceAttribute?.value !== undefined &&
      resourceAttributeRange !== undefined &&
      !/^(?:data:|blob:|#)/i.test(resourceAttribute.value)
    ) {
      const path = resourcePath(resourceAttribute.value, 'index.html');
      const embedded = path === undefined ? undefined : resourceForPath(path, resources);
      if (embedded === undefined) {
        return errorResult(
          'single-html-asset-missing',
          'every local HTML resource to resolve to an embedded dist artifact',
          'Add the referenced asset to the project closure and rebuild.',
          { value: resourceAttribute.value, path: path ?? null },
        );
      }
      replacements.push({
        start: resourceAttributeRange.startOffset,
        end: resourceAttributeRange.endOffset,
        value: dataUri(embedded.bytes, embedded.mediaType),
      });
      continue;
    }
    if (element.name === 'script' && attributeValue(element, 'src') !== undefined) {
      return errorResult(
        'single-html-script-external',
        'non-module script sources to be absent from the generated host',
        'Move the script into the production module entry before packaging.',
        { src: attributeValue(element, 'src') },
      );
    }
  }

  const assetNodes = [...resources.values()]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map(
      (resource, index) =>
        `<script type="application/octet-stream" id="forgeax-asset-${index}" data-forgeax-asset data-path="${escapeAttribute(resource.path)}" data-mime="${escapeAttribute(resource.mediaType)}">${Buffer.from(resource.bytes).toString('base64')}</script>`,
    )
    .join('');
  const bootstrap = `<script type="application/javascript">${safeScriptText(runtimeBootstrap([...resources.values()]))}</script>`;
  const entry = `<script type="module">${safeScriptText(bundle.entrySource)}</script>`;
  const withResources = applyReplacements(indexHtml, replacements);
  const body = `${assetNodes}${bootstrap}${entry}`;
  const html = withResources.includes('</body>')
    ? withResources.replace(/<\/body>/i, () => `${body}</body>`)
    : `${withResources}${body}`;
  return { ok: true, value: { html, embeddedAssets: resources.size } };
}

export async function writeSingleHtml(
  options: SingleHtmlPackageOptions,
): Promise<CommandResult<SingleHtmlPackageResult>> {
  const distRoot = resolve(options.distRoot);
  const output = resolve(options.output);
  const checksumPath = `${output}.sha256`;
  const temporary = `${output}.partial-${process.pid}`;
  const temporaryChecksum = `${checksumPath}.partial-${process.pid}`;
  try {
    const indexHtml = await readFile(resolve(distRoot, 'index.html'), 'utf8');
    const resources = await distResources(distRoot, options.manifest);
    const built = buildHtml(indexHtml, resources, options.bundle);
    if (!built.ok) return built;
    const bytes = Buffer.from(built.value.html, 'utf8');
    const sha256 = hashBytes(bytes);
    const manifestBytes = await readFile(resolve(distRoot, 'forgeax-dist.json'));
    await mkdir(dirname(output), { recursive: true });
    await writeFile(temporary, bytes);
    await writeFile(temporaryChecksum, `${sha256}  ${basename(output)}\n`, 'utf8');
    await rename(temporaryChecksum, checksumPath);
    await rename(temporary, output);
    return {
      ok: true,
      value: {
        schemaVersion: '1.0.0',
        format: SINGLE_HTML_FORMAT,
        target: 'file',
        project: options.manifest.project,
        base: options.manifest.base,
        html: { path: output, bytes: bytes.byteLength, sha256 },
        checksumPath,
        distManifestSha256: hashBytes(manifestBytes),
        embeddedAssets: built.value.embeddedAssets,
        run: {
          local: pathToFileURL(output).href,
          shared: 'send the HTML file and open it in a desktop Chrome with WebGPU support',
        },
      },
    };
  } catch (cause) {
    return toErrorResult(
      cause,
      'single-html-write-failed',
      'the single HTML candidate and adjacent SHA-256 to be written atomically',
      'Repair the dist closure or output directory, then retry packaging.',
    );
  } finally {
    await Promise.all([rm(temporary, { force: true }), rm(temporaryChecksum, { force: true })]);
  }
}

export function packageFormatError(format: string): CommandResult<never> {
  return errorResult(
    'package-format-unsupported',
    'package format to be web-zip or single-html',
    'Use web-zip for HTTPS hosting or single-html for a self-contained file:// delivery.',
    { format },
  );
}

export function packageOutputError(
  output: string,
  format: 'web-zip' | 'single-html',
): CommandResult<never> {
  const expectedSuffix = format === 'single-html' ? '.html' : '.zip';
  return errorResult(
    'package-output-suffix-mismatch',
    `package output to end with ${expectedSuffix}`,
    `Use a ${expectedSuffix} output path for ${format}.`,
    { output, format },
  );
}
