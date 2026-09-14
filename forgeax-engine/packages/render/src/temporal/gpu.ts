import type {
  BindGroupLayout,
  Buffer,
  RhiDevice,
  RhiQueue,
  Sampler,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import type { DeviceScope } from '../device/device-scope';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_UNIFORM } from '../gpu-usage';
import type { RenderFrameState } from '../record/frame-snapshot';

interface TemporalSurface {
  readonly texture: Texture;
  readonly view: TextureView;
}

export interface TemporalGpuState {
  readonly device: RhiDevice;
  readonly scope: DeviceScope;
  readonly childScope: DeviceScope;
  width: number;
  height: number;
  valid: boolean;
  readIndex: 0 | 1;
  pendingIndex: 0 | 1 | undefined;
  readonly color: [TemporalSurface, TemporalSurface];
  readonly temporal: [TemporalSurface, TemporalSurface];
  bindGroupLayout: BindGroupLayout | undefined;
  sampler: Sampler | undefined;
  paramsBuffer: Buffer | undefined;
  committed: boolean;
}

function createSurface(
  device: RhiDevice,
  childScope: DeviceScope,
  label: string,
  width: number,
  height: number,
): TemporalSurface {
  const texture = device.createTexture({
    label,
    size: { width, height, depthOrArrayLayers: 1 },
    format: 'rgba16float',
    textureBindingViewDimension: undefined,
    usage:
      GPU_TEXTURE_USAGE_COPY_SRC |
      GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
      GPU_TEXTURE_USAGE_TEXTURE_BINDING,
  });
  if (!texture.ok) throw texture.error;
  childScope._adopt('texture', texture.value, (value) => {
    device.destroyTexture(value);
  });
  const view = device.createTextureView(texture.value, {
    label: `${label}.view`,
    dimension: '2d',
    baseMipLevel: 0,
    mipLevelCount: 1,
    baseArrayLayer: 0,
    arrayLayerCount: 1,
  });
  if (!view.ok) throw view.error;
  return { texture: texture.value, view: view.value };
}

function createState(
  device: RhiDevice,
  scope: DeviceScope,
  width: number,
  height: number,
): TemporalGpuState {
  const childScope = scope.createChild(`${scope.owner}:temporal`);
  try {
    return {
      device,
      scope,
      childScope,
      width,
      height,
      valid: false,
      readIndex: 0,
      pendingIndex: undefined,
      color: [
        createSurface(device, childScope, 'taa-history-color-a', width, height),
        createSurface(device, childScope, 'taa-history-color-b', width, height),
      ],
      temporal: [
        createSurface(device, childScope, 'taa-history-temporal-a', width, height),
        createSurface(device, childScope, 'taa-history-temporal-b', width, height),
      ],
      bindGroupLayout: undefined,
      sampler: undefined,
      paramsBuffer: undefined,
      committed: false,
    };
  } catch (cause) {
    childScope.abandon();
    throw cause;
  }
}

export function getTemporalParamsBuffer(state: TemporalGpuState): Buffer {
  if (state.paramsBuffer !== undefined) return state.paramsBuffer;
  const created = state.device.createBuffer({
    label: 'taa-resolve-params',
    size: 16,
    usage: GPU_BUFFER_USAGE_UNIFORM | GPU_BUFFER_USAGE_COPY_DST,
    mappedAtCreation: false,
  });
  if (!created.ok) {
    if (!state.committed) state.childScope.abandon();
    throw created.error;
  }
  state.childScope._adopt('buffer', created.value, (value) => {
    state.device.destroyBuffer(value);
  });
  const written = state.device.queue.writeBuffer(created.value, 0, new Uint8Array(16));
  if (!written.ok) {
    if (!state.committed) state.childScope.abandon();
    throw written.error;
  }
  state.paramsBuffer = created.value;
  return created.value;
}

export function getTemporalGpuState(
  frameState: RenderFrameState,
  device: RhiDevice,
  scope: DeviceScope,
  width: number,
  height: number,
): TemporalGpuState {
  const staged = frameState.temporalGpuState;
  if (
    staged !== undefined &&
    staged.scope === scope &&
    staged.width === width &&
    staged.height === height
  ) {
    return staged;
  }
  const existing = frameState.activeTemporalGpuState;
  if (
    existing !== undefined &&
    existing.scope === scope &&
    existing.width === width &&
    existing.height === height
  ) {
    return existing;
  }
  const next = createState(device, scope, width, height);
  frameState.temporalGpuState = next;
  return next;
}

export function getTemporalBindGroupResources(state: TemporalGpuState): {
  readonly layout: BindGroupLayout;
  readonly sampler: Sampler | null;
} {
  if (state.bindGroupLayout !== undefined) {
    return {
      layout: state.bindGroupLayout,
      sampler: state.sampler ?? null,
    };
  }
  try {
    const layout = state.device.createBindGroupLayout({
      label: 'taa-resolve-bind-group',
      entries: [
        {
          binding: 0,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        { binding: 1, visibility: 2, sampler: { type: 'non-filtering' } },
        {
          binding: 2,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        { binding: 3, visibility: 2, sampler: { type: 'non-filtering' } },
        {
          binding: 4,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        { binding: 5, visibility: 2, sampler: { type: 'non-filtering' } },
        {
          binding: 6,
          visibility: 2,
          texture: { sampleType: 'unfilterable-float', viewDimension: '2d' },
        },
        { binding: 7, visibility: 2, sampler: { type: 'non-filtering' } },
        { binding: 8, visibility: 2, buffer: { type: 'uniform' } },
      ],
    });
    if (!layout.ok) throw layout.error;
    state.childScope._adopt('binding', layout.value, () => undefined);
    const sampler = state.device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      magFilter: 'nearest',
      minFilter: 'nearest',
    });
    if (!sampler.ok) throw sampler.error;
    state.childScope._adopt('binding', sampler.value, () => undefined);
    state.bindGroupLayout = layout.value;
    state.sampler = sampler.value;
    return { layout: layout.value, sampler: sampler.value };
  } catch (cause) {
    if (!state.committed) {
      state.childScope.abandon();
      state.bindGroupLayout = undefined;
      state.sampler = undefined;
    }
    throw cause;
  }
}

export function temporalReadIndex(state: TemporalGpuState): 0 | 1 {
  return state.readIndex;
}

export function temporalWriteIndex(state: TemporalGpuState): 0 | 1 {
  return state.readIndex === 0 ? 1 : 0;
}

export function stageTemporalGpuSubmit(state: TemporalGpuState): void {
  state.pendingIndex = state.readIndex === 0 ? 1 : 0;
}

export function hasPendingTemporalGpuSubmit(state: TemporalGpuState): boolean {
  return state.pendingIndex !== undefined;
}

export function commitTemporalGpuSubmit(state: TemporalGpuState): boolean {
  if (state.pendingIndex === undefined) return false;
  state.readIndex = state.pendingIndex;
  state.pendingIndex = undefined;
  state.valid = true;
  state.committed = true;
  return true;
}

export function abortTemporalGpuSubmit(state: TemporalGpuState): void {
  state.pendingIndex = undefined;
}

export function retireTemporalGpuState(state: TemporalGpuState): void {
  state.pendingIndex = undefined;
  state.childScope.retire();
  state.valid = false;
  state.committed = false;
  state.bindGroupLayout = undefined;
  state.sampler = undefined;
  state.paramsBuffer = undefined;
}

export function retireTemporalGpuStateAfterFence(
  state: TemporalGpuState,
  queue: RhiQueue,
  retiring: Set<TemporalGpuState>,
  onFailure: (cause: unknown) => void,
): void {
  if (state.childScope.state === 'retired' || state.childScope.state === 'abandoned') return;
  state.childScope.beginRetire();
  retiring.add(state);
  void queue.onSubmittedWorkDone().then(
    () => {
      retiring.delete(state);
      retireTemporalGpuState(state);
    },
    (cause) => {
      retiring.delete(state);
      onFailure(cause);
      retireTemporalGpuState(state);
    },
  );
}
