import type { SchemaOf, ShapeOf } from '@forgeax/engine-ecs';
import type { Handle } from '@forgeax/engine-types';
import { expectTypeOf, it } from 'vitest';
import type { Camera } from '../components/camera';
import type { FrameObservationRequest } from '../render-contract';
import type {
  RenderTargetReadbackData,
  RenderTargetReadbackTicket,
  RenderTargetTextureSource,
} from '../targets/contracts';

it('keeps Camera target as a simulation-transient shared RenderTarget handle', () => {
  expectTypeOf<ShapeOf<SchemaOf<typeof Camera>>['target']>().toEqualTypeOf<
    Handle<'RenderTarget', 'shared'>
  >();
});

it('keeps target material source opaque and receipt readback data explicit', () => {
  type NoProperty<T, K extends PropertyKey> = Extract<keyof T, K> extends never ? true : false;
  expectTypeOf<NoProperty<RenderTargetTextureSource, 'texture'>>().toEqualTypeOf<true>();
  expectTypeOf<NoProperty<RenderTargetTextureSource, 'view'>>().toEqualTypeOf<true>();
  expectTypeOf<NoProperty<RenderTargetTextureSource, 'colorSpace'>>().toEqualTypeOf<true>();
  expectTypeOf<FrameObservationRequest['include'][number]>().toMatchTypeOf<
    'target-readbacks' | 'timings' | 'draws' | 'bindings'
  >();
  expectTypeOf<FrameObservationRequest['targetReadbacks']>().toEqualTypeOf<
    readonly RenderTargetReadbackTicket[] | undefined
  >();
  expectTypeOf<RenderTargetReadbackData['bytes']>().toEqualTypeOf<Uint8Array>();
});
