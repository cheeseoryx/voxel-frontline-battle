import type { Texture, TextureView } from '@forgeax/engine-rhi';
import type { RenderTargetDescriptor } from './contracts';

/** Renderer-private physical storage for one logical target generation. */
export interface RenderTargetPhysical {
  readonly generation: number;
  readonly descriptor: RenderTargetDescriptor;
  readonly texture: Texture;
  readonly view: TextureView;
  readonly mipViews: readonly TextureView[];
  readonly colorTextures: readonly Texture[];
  readonly faceViews: readonly TextureView[];
  readonly depthTextures: readonly Texture[];
  readonly depthViews: readonly TextureView[];
  readonly resolveTexture?: Texture;
  readonly resolveView: TextureView;
  readonly resolveFaceViews: readonly TextureView[];
}
