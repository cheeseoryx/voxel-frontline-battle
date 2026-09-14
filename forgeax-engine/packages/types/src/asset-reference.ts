import type { Asset } from './index.js';

/** Structured edge metadata carried in an asset envelope refs list. */
interface LegacyAssetRef {
  readonly guid: string;
  readonly sourceField?: {
    readonly componentName?: string;
    readonly fieldName: string;
    readonly arrayIndex?: number;
  };
  readonly sceneEntityId?: number;
}

export type AssetRef<K extends string = never> = [K] extends [never]
  ? LegacyAssetRef
  : LegacyAssetRef & {
      readonly kind: K;
      readonly sourceKey: string;
    };

export interface SceneEntityRef {
  readonly sceneSourceKey: string;
  readonly bindingKey: string;
}

/** Self-contained asset envelope used from import through catalog loading. */
export interface AssetEnvelope<P = Asset> {
  readonly guid: string;
  readonly kind: string;
  readonly name?: string;
  readonly payload: P;
  readonly refs: readonly AssetRef[];
}
