export interface TemplateManifestPlugin {
  readonly name: string;
  readonly realm?: string;
  readonly group?: boolean;
}

export interface TemplateManifest {
  readonly plugins: readonly TemplateManifestPlugin[];
}

export interface TemplateModule {
  readonly default?: unknown;
  readonly [key: string]: unknown;
}

export type TemplateModuleLoader = () => Promise<TemplateModule>;
export type TemplateModuleCatalog = Readonly<Record<string, TemplateModuleLoader>>;

export type TemplateModuleResolutionErrorCode =
  | 'no-local-engine-module'
  | 'ambiguous-local-engine-module';

export interface TemplateModuleResolutionErrorDetail {
  readonly slug: string;
  readonly candidates: readonly string[];
  readonly matchedKeys: readonly string[];
}

export class TemplateModuleResolutionError extends Error {
  readonly code: TemplateModuleResolutionErrorCode;
  readonly detail: TemplateModuleResolutionErrorDetail;

  constructor(
    code: TemplateModuleResolutionErrorCode,
    detail: TemplateModuleResolutionErrorDetail,
  ) {
    super(
      `[TemplateModuleResolutionError ${code}] template ${detail.slug} has ${
        code === 'no-local-engine-module'
          ? 'no catalog-backed local Engine module'
          : 'multiple catalog-backed local Engine modules'
      }`,
    );
    this.name = 'TemplateModuleResolutionError';
    this.code = code;
    this.detail = detail;
  }
}

function templateModuleKey(slug: string, name: string): string {
  const root =
    slug === 'game-default' || slug === 'game-capability-lab'
      ? '../../game-capability-lab'
      : slug === 'brotato-3d'
        ? '../../showcase/brotato-3d'
        : `../../../templates/${slug}`;
  return `${root}/${name.slice(2)}`;
}

export function resolveTemplateModule(
  slug: string,
  manifest: TemplateManifest,
  catalog: TemplateModuleCatalog,
): TemplateModuleLoader {
  const candidates = manifest.plugins
    .filter(
      (plugin) =>
        (plugin.realm === undefined || plugin.realm === 'engine') && plugin.group !== true,
    )
    .map((plugin) => plugin.name)
    .filter((name) => name.startsWith('./'));
  const matches = candidates
    .map((name) => ({ name, key: templateModuleKey(slug, name) }))
    .filter(({ key }) => catalog[key] !== undefined);

  if (matches.length === 0) {
    throw new TemplateModuleResolutionError('no-local-engine-module', {
      slug,
      candidates,
      matchedKeys: [],
    });
  }
  if (matches.length > 1) {
    throw new TemplateModuleResolutionError('ambiguous-local-engine-module', {
      slug,
      candidates,
      matchedKeys: matches.map(({ key }) => key),
    });
  }
  const match = matches[0];
  if (match === undefined) {
    throw new TemplateModuleResolutionError('no-local-engine-module', {
      slug,
      candidates,
      matchedKeys: [],
    });
  }
  const loader = catalog[match.key];
  if (loader === undefined) {
    throw new TemplateModuleResolutionError('no-local-engine-module', {
      slug,
      candidates,
      matchedKeys: [],
    });
  }
  return loader;
}
