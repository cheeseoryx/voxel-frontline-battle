import type { ToolEvidenceKind, ToolRealm } from '@forgeax/engine-tool-runtime';

/**
 * A source-only command declaration.  Project discovery may load this contract
 * without importing the executor, DOM, World, or a running Project.
 */
export interface ToolCommandDeclaration {
  readonly id: string;
  readonly path?: readonly string[];
  readonly title: string;
  readonly summary: string;
  readonly realm: ToolRealm;
  readonly argsSchema?: string;
  readonly resultSchema?: string;
  readonly evidence?: readonly ToolEvidenceKind[];
  /** Module specifier resolved only when the command is executed. */
  readonly executor?: string;
  readonly exportName?: string;
}

export interface ToolCommandContract {
  readonly schemaVersion: '1.0.0';
  readonly commands: readonly ToolCommandDeclaration[];
}

export function defineToolCommandContract(
  commands: readonly ToolCommandDeclaration[],
): ToolCommandContract {
  return { schemaVersion: '1.0.0', commands: [...commands] };
}

export function isToolCommandContract(value: unknown): value is ToolCommandContract {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<ToolCommandContract>;
  return candidate.schemaVersion === '1.0.0' && Array.isArray(candidate.commands);
}
