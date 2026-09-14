import { asset } from 'virtual:forgeax/assets';
import { AssetGuid } from '@forgeax/engine/pack/guid';
import type { AssetGuid as AssetGuidType } from '@forgeax/engine/types';

export function authoredGuid(sourceKey: 'ui/guide'): ReturnType<typeof AssetGuid.parse> {
  return AssetGuid.parse(asset(sourceKey).guid);
}

export function guidText(value: AssetGuidType): string {
  return AssetGuid.format(value);
}
