import type { EcsError, EntityHandle } from '@forgeax/engine-ecs';

export type SceneErrorCode = 'hierarchy-broken' | 'hierarchy-cycle';

/** Scene-instantiation failures owned by the scene package. */
export type SceneInstanceErrorCode = 'component-not-defined' | 'scene-override-type-mismatch';

export { ComponentNotDefinedError } from '@forgeax/engine-ecs/projection';

/** The structured ECS failure retained by a Scene derived-write diagnostic. */
export interface SceneErrorCause {
  readonly code: EcsError['code'];
  readonly expected?: string;
  readonly hint?: string;
  readonly detail?: unknown;
}

/** Location detail shared by hierarchy diagnostics and derived-write errors. */
export interface SceneHierarchyErrorDetail {
  readonly kind?: 'hierarchy';
  readonly entity: EntityHandle;
  readonly parent: EntityHandle;
}

/** A flat derived publication failure with its original ECS error intact. */
export interface SceneDerivedWriteErrorDetail {
  readonly kind: 'derived-write';
  readonly entity: EntityHandle;
  readonly parent: EntityHandle;
  readonly bindingIndex: number;
  readonly base: number;
  readonly start: number;
  readonly count: number;
  readonly cause: SceneErrorCause;
}

export type SceneErrorDetail = SceneHierarchyErrorDetail | SceneDerivedWriteErrorDetail;

export class SceneError extends Error {
  readonly code: SceneErrorCode;
  readonly expected: string;
  readonly hint: string;
  readonly detail: SceneErrorDetail | undefined;

  constructor(args: {
    code: SceneErrorCode;
    expected: string;
    hint: string;
    detail?: SceneErrorDetail;
  }) {
    super(`[SceneError ${args.code}] expected: ${args.expected}; hint: ${args.hint}`);
    this.name = 'SceneError';
    this.code = args.code;
    this.expected = args.expected;
    this.hint = args.hint;
    this.detail = args.detail;
  }
}
