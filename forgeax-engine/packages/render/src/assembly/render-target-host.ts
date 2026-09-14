import type {
  Buffer,
  RhiCommandEncoder,
  RhiDevice,
  Texture,
  TextureView,
} from '@forgeax/engine-rhi';
import type { RenderError } from '../errors/render';
import {
  RenderTargetCapabilityMissingError,
  RenderTargetDescriptorInvalidError,
  RenderTargetOperationFailedError,
  RenderTargetStateInvalidError,
} from '../errors/render';
import {
  GPU_TEXTURE_USAGE_COPY_SRC,
  GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
  GPU_TEXTURE_USAGE_TEXTURE_BINDING,
} from '../gpu-texture-usage';
import { GPU_BUFFER_USAGE_COPY_DST, GPU_BUFFER_USAGE_MAP_READ } from '../gpu-usage';
import { resolveRenderTargetMipExtent } from '../record/frame-targets';
import type { RenderResult } from '../render-contract';
import {
  admitRenderTargetDescriptor,
  type RenderTarget,
  type RenderTargetAdmissionLimits,
  type RenderTargetDescriptor,
  type RenderTargetReadbackData,
  type RenderTargetReadbackRequest,
  type RenderTargetReadbackTicket,
  type RenderTargetTextureSource,
  type RenderTargetTextureSourceOptions,
} from '../targets/contracts';
import {
  createRenderTargetMaterialSource,
  type RenderTargetMaterialSourceBinding,
  resolveRenderTargetMaterialSource,
} from '../targets/material-source';
import { createRenderTargetOwner, type RenderTargetOwner } from '../targets/owner';
import type { RenderTargetPhysical } from '../targets/physical';
import {
  bindRenderTargetReadbackTicket,
  completeRenderTargetReadback,
  createRenderTargetReadbackTicket,
  type RenderTargetReadbackTicket as InternalReadbackTicket,
  type RenderTargetReadbackReceipt,
} from '../targets/readback';

export interface RenderTargetHostOptions {
  readonly rendererId?: symbol;
  readonly initialGeneration?: number;
  readonly getGeneration?: () => number;
  readonly limits?: RenderTargetAdmissionLimits;
  readonly getDevice?: () => RhiDevice;
  /**
   * Renderer-owned candidate publication gate. Progressive cube capture keeps
   * a target candidate across face submissions and returns true only after the
   * capture scheduler has committed all faces for the matching fence.
   */
  readonly canPromoteTarget?: (target: RenderTarget) => boolean;
}

const DEFAULT_LIMITS: RenderTargetAdmissionLimits = {
  maxTextureDimension2D: 8192,
  maxBytesPerTarget: 256 * 1024 * 1024,
  renderableFormats: ['rgba16float', 'rgba8unorm', 'rgba8unorm-srgb'],
  sampleCounts: [1, 4],
  depthFormats: ['depth24plus-stencil8', 'depth32float'],
};

interface ReadbackRecord {
  readonly target: RenderTarget;
  readonly request: RenderTargetReadbackRequest;
  readonly ticket: InternalReadbackTicket;
  readonly buffer?: Buffer;
  encoded: boolean;
}

export interface RenderTargetHost {
  /** The logical owner for every target lifecycle operation. */
  readonly owner: 'renderer';
  createRenderTarget(descriptor: RenderTargetDescriptor): RenderResult<RenderTarget, RenderError>;
  resizeRenderTarget(
    target: RenderTarget,
    descriptor: RenderTargetDescriptor,
  ): RenderResult<void, RenderError>;
  createRenderTargetTextureSource(
    target: RenderTarget,
    options: RenderTargetTextureSourceOptions,
  ): RenderResult<RenderTargetTextureSource, RenderError>;
  /** @internal Resolve a source for the existing material projection path. */
  resolveRenderTargetTextureSource(
    source: RenderTargetTextureSource,
  ): RenderTargetMaterialSourceBinding | undefined;
  requestTargetReadback(
    target: RenderTarget,
    request: RenderTargetReadbackRequest,
  ): RenderResult<RenderTargetReadbackTicket, RenderError>;
  observeTargetReadbacks(
    receipt: RenderTargetReadbackReceipt,
    tickets: readonly RenderTargetReadbackTicket[],
  ): Promise<RenderResult<readonly RenderTargetReadbackData[], RenderError>>;
  /** @internal Physical target used by the active Standard frame. */
  getPhysicalTarget(target: RenderTarget): RenderTargetPhysical | undefined;
  /** @internal Add pending target copies to the frame's sole encoder. */
  encodePendingReadbacks(encoder: RhiCommandEncoder, faces?: readonly number[]): void;
  destroyRenderTarget(target: RenderTarget): RenderResult<void, RenderError>;
  /** Called immediately before the existing Standard frame is interpreted. */
  beginFrame(): void;
  /** Called only after the existing Renderer frame submission is accepted. */
  onFrameSubmitted(completed?: Promise<RenderResult<void, RenderError>>): void;
  /** Called after a replacement DeviceScope generation becomes active. */
  recover(): void;
  /** Called before Renderer-owned physical resources are released. */
  dispose(): void;
}

function opaqueTicket(): RenderTargetReadbackTicket {
  return Object.freeze({}) as RenderTargetReadbackTicket;
}

function bytesPerPixel(format: RenderTargetDescriptor['format']): number {
  return format === 'rgba16float' ? 8 : 4;
}

function mipCount(descriptor: RenderTargetDescriptor): number {
  return descriptor.mipLevels === 1
    ? 1
    : Math.floor(Math.log2(Math.max(descriptor.width, descriptor.height))) + 1;
}

function makePhysical(
  device: RhiDevice,
  descriptor: RenderTargetDescriptor,
  generation: number,
): RenderResult<RenderTargetPhysical, RenderError> {
  const layers = descriptor.shape === 'cube' ? 6 : 1;
  const usage =
    GPU_TEXTURE_USAGE_RENDER_ATTACHMENT |
    (descriptor.sampled ? GPU_TEXTURE_USAGE_TEXTURE_BINDING : 0) |
    (descriptor.readback ? GPU_TEXTURE_USAGE_COPY_SRC : 0);
  const created = device.createTexture({
    label: `render-target.${generation}`,
    size: { width: descriptor.width, height: descriptor.height, depthOrArrayLayers: layers },
    format: descriptor.format,
    mipLevelCount: mipCount(descriptor),
    // WebGPU forbids multisampled array textures. The cube is always the
    // single-sample resolve destination; MSAA capture uses one depth=1 color
    // texture per face below.
    sampleCount: 1,
    dimension: '2d',
    usage,
    viewFormats: undefined,
    textureBindingViewDimension: descriptor.shape === 'cube' ? 'cube' : undefined,
  });
  if (!created.ok)
    return {
      ok: false,
      error: new RenderTargetOperationFailedError({
        operation: 'create',
        stage: 'allocation',
        generation,
        cause: created.error,
        recovery: 'retry',
      }),
    };
  const texture = created.value;
  const view = device.createTextureView(texture, {
    dimension: descriptor.shape,
    baseMipLevel: 0,
    mipLevelCount: mipCount(descriptor),
    baseArrayLayer: 0,
    arrayLayerCount: layers,
  });
  if (!view.ok)
    return {
      ok: false,
      error: new RenderTargetOperationFailedError({
        operation: 'create',
        stage: 'allocation',
        generation,
        cause: view.error,
        recovery: 'retry',
      }),
    };
  const mipViews: TextureView[] = [];
  for (let mip = 0; mip < mipCount(descriptor); mip += 1) {
    const mipView = device.createTextureView(texture, {
      dimension: descriptor.shape,
      baseMipLevel: mip,
      mipLevelCount: 1,
      baseArrayLayer: 0,
      arrayLayerCount: layers,
    });
    if (!mipView.ok)
      return {
        ok: false,
        error: new RenderTargetOperationFailedError({
          operation: 'create',
          stage: 'allocation',
          generation,
          cause: mipView.error,
          recovery: 'retry',
        }),
      };
    mipViews.push(mipView.value);
  }
  const resolveFaceViews: TextureView[] = [];
  for (let face = 0; face < layers; face += 1) {
    const faceView = device.createTextureView(texture, {
      dimension: '2d',
      baseMipLevel: 0,
      mipLevelCount: 1,
      baseArrayLayer: face,
      arrayLayerCount: 1,
    });
    if (!faceView.ok)
      return {
        ok: false,
        error: new RenderTargetOperationFailedError({
          operation: 'create',
          stage: 'allocation',
          generation,
          cause: faceView.error,
          recovery: 'retry',
        }),
      };
    resolveFaceViews.push(faceView.value);
  }
  const colorTextures: Texture[] = [];
  const faceViews: TextureView[] = [];
  const depthTextures: Texture[] = [];
  const depthViews: TextureView[] = [];
  if (descriptor.shape === 'cube') {
    for (let face = 0; face < layers; face += 1) {
      const depth = device.createTexture({
        label: `render-target.${generation}.depth.${face}`,
        size: {
          width: descriptor.width,
          height: descriptor.height,
          depthOrArrayLayers: descriptor.sampleCount === 4 ? 1 : layers,
        },
        mipLevelCount: 1,
        sampleCount: descriptor.sampleCount,
        dimension: '2d',
        format: 'depth24plus-stencil8',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        viewFormats: undefined,
        textureBindingViewDimension: undefined,
      });
      if (!depth.ok)
        return {
          ok: false,
          error: new RenderTargetOperationFailedError({
            operation: 'create',
            stage: 'allocation',
            generation,
            cause: depth.error,
            recovery: 'retry',
          }),
        };
      const depthView = device.createTextureView(depth.value, {
        dimension: '2d',
        baseArrayLayer: descriptor.sampleCount === 4 ? 0 : face,
        arrayLayerCount: 1,
      });
      if (!depthView.ok)
        return {
          ok: false,
          error: new RenderTargetOperationFailedError({
            operation: 'create',
            stage: 'allocation',
            generation,
            cause: depthView.error,
            recovery: 'retry',
          }),
        };
      depthTextures.push(depth.value);
      depthViews.push(depthView.value);
    }
  }
  if (descriptor.sampleCount === 4) {
    for (let face = 0; face < layers; face += 1) {
      const msaa = device.createTexture({
        label: `render-target.${generation}.msaa.${face}`,
        size: { width: descriptor.width, height: descriptor.height, depthOrArrayLayers: 1 },
        format: descriptor.format,
        mipLevelCount: 1,
        sampleCount: 4,
        dimension: '2d',
        usage: GPU_TEXTURE_USAGE_RENDER_ATTACHMENT,
        viewFormats: undefined,
        textureBindingViewDimension: undefined,
      });
      if (!msaa.ok)
        return {
          ok: false,
          error: new RenderTargetOperationFailedError({
            operation: 'create',
            stage: 'allocation',
            generation,
            cause: msaa.error,
            recovery: 'retry',
          }),
        };
      const msaaView = device.createTextureView(msaa.value, {
        dimension: '2d',
        baseMipLevel: 0,
        mipLevelCount: 1,
        baseArrayLayer: 0,
        arrayLayerCount: 1,
      });
      if (!msaaView.ok)
        return {
          ok: false,
          error: new RenderTargetOperationFailedError({
            operation: 'create',
            stage: 'allocation',
            generation,
            cause: msaaView.error,
            recovery: 'retry',
          }),
        };
      colorTextures.push(msaa.value);
      faceViews.push(msaaView.value);
    }
  } else {
    for (let face = 0; face < layers; face += 1) {
      colorTextures.push(texture);
      faceViews.push(resolveFaceViews[face] ?? view.value);
    }
  }
  return {
    ok: true,
    value: {
      generation,
      descriptor,
      texture,
      view: view.value,
      mipViews,
      colorTextures,
      faceViews,
      depthTextures,
      depthViews,
      ...(descriptor.sampleCount === 4 ? { resolveTexture: texture } : {}),
      resolveView: view.value,
      resolveFaceViews,
    },
  };
}

function destroyPhysical(
  device: RhiDevice | undefined,
  physical: RenderTargetPhysical | undefined,
): void {
  if (device === undefined || physical === undefined) return;
  const textures = new Set<Texture>();
  textures.add(physical.texture);
  if (physical.resolveTexture !== undefined) textures.add(physical.resolveTexture);
  for (const texture of physical.colorTextures) textures.add(texture);
  for (const texture of physical.depthTextures) textures.add(texture);
  for (const texture of textures) device.destroyTexture(texture);
}

export function createRenderTargetHost(options: RenderTargetHostOptions = {}): RenderTargetHost {
  let disposed = false;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const owner: RenderTargetOwner = createRenderTargetOwner({
    rendererId: options.rendererId ?? Symbol('renderer'),
    initialGeneration: options.initialGeneration ?? 0,
  });
  const targets = new Set<RenderTarget>();
  const staged = new Set<RenderTarget>();
  const activePhysical = new WeakMap<object, RenderTargetPhysical>();
  const candidatePhysical = new WeakMap<object, RenderTargetPhysical>();
  const sources = new WeakMap<object, RenderTargetMaterialSourceBinding>();
  const readbacks = new WeakMap<object, ReadbackRecord>();
  const readbackRecords = new Set<ReadbackRecord>();
  const currentGeneration = (): number =>
    options.getGeneration?.() ?? options.initialGeneration ?? 0;
  const stagePhysical = (
    target: RenderTarget,
    descriptor?: RenderTargetDescriptor,
  ): RenderResult<void, RenderError> => {
    const stagedTarget = owner.stage(target, descriptor);
    if (!stagedTarget.ok) return stagedTarget;
    const device = options.getDevice?.();
    if (device === undefined) {
      staged.add(target);
      return { ok: true, value: undefined };
    }
    const physical = makePhysical(
      device,
      stagedTarget.value.descriptor,
      stagedTarget.value.generation,
    );
    if (!physical.ok) {
      owner.rejectCandidate(target, stagedTarget.value.generation, 'allocation');
      return physical;
    }
    candidatePhysical.set(target as object, physical.value);
    staged.add(target);
    return { ok: true, value: undefined };
  };

  return Object.freeze({
    owner: 'renderer' as const,
    createRenderTarget(
      descriptor: RenderTargetDescriptor,
    ): RenderResult<RenderTarget, RenderError> {
      if (disposed) {
        return {
          ok: false,
          error: new RenderTargetStateInvalidError({
            operation: 'inspect',
            reason: 'destroyed',
            state: 'destroyed',
            generation: currentGeneration(),
          }),
        };
      }
      const admitted = admitRenderTargetDescriptor(descriptor, limits);
      if (!admitted.ok) return admitted;
      const created = owner.create(admitted.value);
      if (created.ok) targets.add(created.value);
      return created;
    },
    resizeRenderTarget(
      target: RenderTarget,
      descriptor: RenderTargetDescriptor,
    ): RenderResult<void, RenderError> {
      const admitted = admitRenderTargetDescriptor(descriptor, limits);
      if (!admitted.ok) return admitted;
      return stagePhysical(target, admitted.value);
    },
    createRenderTargetTextureSource(
      target: RenderTarget,
      sourceOptions: RenderTargetTextureSourceOptions,
    ): RenderResult<RenderTargetTextureSource, RenderError> {
      const inspected = owner.inspect(target);
      if (!inspected.ok) return inspected;
      if (!inspected.value.descriptor.sampled) {
        return {
          ok: false,
          error: new RenderTargetCapabilityMissingError({
            operation: 'source',
            requested: 'sampled=true',
            capability: 'sampled',
            actual: 'false',
          }),
        };
      }
      if (sourceOptions.dimension !== inspected.value.descriptor.shape) {
        return {
          ok: false,
          error: new RenderTargetDescriptorInvalidError({
            field: 'dimension',
            value: sourceOptions.dimension,
            expected: `dimension matches ${inspected.value.descriptor.shape}`,
          }),
        };
      }
      if (
        !Number.isInteger(sourceOptions.mipLevel) ||
        sourceOptions.mipLevel < 0 ||
        (inspected.value.descriptor.mipLevels === 1 && sourceOptions.mipLevel !== 0)
      ) {
        return {
          ok: false,
          error: new RenderTargetDescriptorInvalidError({
            field: 'mipLevel',
            value: sourceOptions.mipLevel,
            expected: 'an admitted mip level for the target',
          }),
        };
      }
      const binding = createRenderTargetMaterialSource(target, inspected.value.descriptor, {
        ...sourceOptions,
        generation: inspected.value.generation,
      });
      if (!binding.ok) return binding;
      sources.set(binding.value.source as object, binding.value);
      return { ok: true, value: binding.value.source };
    },
    resolveRenderTargetTextureSource(source: RenderTargetTextureSource) {
      const binding = sources.get(source as object) ?? resolveRenderTargetMaterialSource(source);
      if (binding === undefined) return undefined;
      const physical = activePhysical.get(binding.target as object);
      if (physical === undefined) return binding;
      const view =
        physical.mipViews[binding.view.mipLevel] ??
        (binding.shape === 'cube' ? physical.view : physical.resolveView);
      if (binding.generation !== physical.generation) return binding;
      return { ...binding, textureView: view };
    },
    requestTargetReadback(
      target: RenderTarget,
      request: RenderTargetReadbackRequest,
    ): RenderResult<RenderTargetReadbackTicket, RenderError> {
      const inspected = owner.inspect(target);
      if (!inspected.ok) return inspected;
      if (!inspected.value.descriptor.readback) {
        return {
          ok: false,
          error: new RenderTargetCapabilityMissingError({
            operation: 'readback',
            requested: 'readback=true',
            capability: 'readback',
            actual: 'false',
          }),
        };
      }
      if (!Number.isInteger(request.mipLevel) || request.mipLevel < 0) {
        return {
          ok: false,
          error: new RenderTargetDescriptorInvalidError({
            field: 'mipLevel',
            value: request.mipLevel,
            expected: 'a non-negative integer',
          }),
        };
      }
      const mipCount =
        inspected.value.descriptor.mipLevels === 1
          ? 1
          : Math.floor(
              Math.log2(
                Math.max(inspected.value.descriptor.width, inspected.value.descriptor.height),
              ),
            ) + 1;
      if (request.mipLevel >= mipCount) {
        return {
          ok: false,
          error: new RenderTargetDescriptorInvalidError({
            field: 'mipLevel',
            value: request.mipLevel,
            expected: `mipLevel < ${mipCount}`,
          }),
        };
      }
      if (
        request.face !== undefined &&
        (!Number.isInteger(request.face) ||
          request.face < 0 ||
          request.face > 5 ||
          inspected.value.descriptor.shape !== 'cube')
      ) {
        return {
          ok: false,
          error: new RenderTargetDescriptorInvalidError({
            field: 'face',
            value: request.face,
            expected:
              inspected.value.descriptor.shape === 'cube'
                ? 'an integer in [0, 5]'
                : 'omitted for a 2d target',
          }),
        };
      }
      const ticket = opaqueTicket();
      const extent = resolveRenderTargetMipExtent(inspected.value.descriptor, request.mipLevel);
      const buffer = options.getDevice?.()?.createBuffer({
        label: `render-target-readback.${request.mipLevel}.${request.face ?? 0}`,
        size:
          Math.ceil((extent.width * bytesPerPixel(inspected.value.descriptor.format)) / 256) *
          256 *
          extent.height,
        usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
        mappedAtCreation: false,
      });
      if (buffer !== undefined && !buffer.ok) {
        return {
          ok: false,
          error: new RenderTargetOperationFailedError({
            operation: 'readback',
            stage: 'allocation',
            generation: inspected.value.generation,
            cause: buffer.error,
            recovery: 'retry',
          }),
        };
      }
      const internalTicket = createRenderTargetReadbackTicket(target, {
        deviceGeneration: inspected.value.generation,
        mipLevel: request.mipLevel,
        ...(request.face === undefined ? {} : { face: request.face }),
        width: extent.width,
        height: extent.height,
        bytesPerPixel: bytesPerPixel(inspected.value.descriptor.format),
      });
      if (!internalTicket.ok) return internalTicket;
      const record = {
        target,
        request,
        ticket: internalTicket.value,
        ...(buffer === undefined ? {} : { buffer: buffer.value }),
        encoded: false,
      } satisfies ReadbackRecord;
      readbacks.set(ticket as object, record);
      readbackRecords.add(record);
      return { ok: true, value: ticket };
    },
    async observeTargetReadbacks(
      receipt: RenderTargetReadbackReceipt,
      tickets: readonly RenderTargetReadbackTicket[],
    ): Promise<RenderResult<readonly RenderTargetReadbackData[], RenderError>> {
      const results: RenderTargetReadbackData[] = [];
      for (const publicTicket of tickets) {
        const record = readbacks.get(publicTicket as object);
        if (record === undefined) {
          return {
            ok: false,
            error: new RenderTargetStateInvalidError({
              operation: 'readback',
              reason: 'foreign-renderer',
              state: 'destroyed',
              generation: receipt.deviceGeneration,
            }),
          };
        }
        const inspected = owner.inspect(record.target);
        if (!inspected.ok) return inspected;
        if (inspected.value.state !== 'active') {
          return {
            ok: false,
            error: new RenderTargetStateInvalidError({
              operation: 'readback',
              reason: 'uninitialized',
              state: inspected.value.state,
              generation: inspected.value.generation,
            }),
          };
        }
        if (inspected.value.generation !== receipt.deviceGeneration) {
          return {
            ok: false,
            error: new RenderTargetStateInvalidError({
              operation: 'readback',
              reason: 'generation-mismatch',
              state: inspected.value.state,
              generation: inspected.value.generation,
            }),
          };
        }
        const bound = bindRenderTargetReadbackTicket(record.ticket, receipt);
        if (!bound.ok) return bound;
        let bytes = new Uint8Array(record.ticket.byteLength);
        if (record.buffer !== undefined && typeof record.buffer.mapAsync === 'function') {
          const mapped = await record.buffer.mapAsync(1);
          if (!mapped.ok) {
            return {
              ok: false,
              error: new RenderTargetOperationFailedError({
                operation: 'readback',
                stage: 'copy',
                generation: receipt.deviceGeneration,
                cause: mapped.error,
                recovery: 'retry',
              }),
            };
          }
          const range = mapped.value.getMappedRange();
          if (!range.ok) {
            return {
              ok: false,
              error: new RenderTargetOperationFailedError({
                operation: 'readback',
                stage: 'copy',
                generation: receipt.deviceGeneration,
                cause: range.error,
                recovery: 'retry',
              }),
            };
          }
          bytes = new Uint8Array(range.value.slice(0));
          mapped.value.unmap();
        }
        const completed = completeRenderTargetReadback(record.ticket, receipt, bytes);
        if (!completed.ok) return completed;
        results.push({
          ticket: publicTicket,
          bytes: completed.value.bytes,
          frameId: completed.value.frameId,
          deviceGeneration: completed.value.deviceGeneration,
          mipLevel: completed.value.mipLevel,
          ...(completed.value.face === undefined ? {} : { face: completed.value.face }),
          bytesPerRow: record.ticket.bytesPerRow,
          byteLength: record.ticket.byteLength,
        });
      }
      return { ok: true, value: Object.freeze(results) };
    },
    destroyRenderTarget(target: RenderTarget): RenderResult<void, RenderError> {
      const destroyed = owner.destroy(target);
      if (destroyed.ok) {
        destroyPhysical(options.getDevice?.(), activePhysical.get(target as object));
        destroyPhysical(options.getDevice?.(), candidatePhysical.get(target as object));
        activePhysical.delete(target as object);
        candidatePhysical.delete(target as object);
        for (const record of readbackRecords) {
          if (record.target !== target) continue;
          if (record.buffer !== undefined) options.getDevice?.()?.destroyBuffer(record.buffer);
          readbacks.delete(record.ticket as object);
          readbackRecords.delete(record);
        }
        targets.delete(target);
      }
      return destroyed;
    },
    beginFrame(): void {
      if (disposed) return;
      for (const target of targets) {
        const inspected = owner.inspect(target);
        if (
          !inspected.ok ||
          inspected.value.state === 'active' ||
          inspected.value.state === 'candidate'
        ) {
          continue;
        }
        stagePhysical(target);
      }
    },
    onFrameSubmitted(completed = Promise.resolve({ ok: true, value: undefined } as const)): void {
      if (disposed) return;
      const submittedTargets = [...staged];
      staged.clear();
      void completed.then((result) => {
        for (const target of submittedTargets) {
          const candidate = owner.inspect(target);
          if (!candidate.ok || candidate.value.candidate === undefined) continue;
          if (!result.ok) {
            owner.rejectCandidate(target, candidate.value.candidate.generation, 'submit');
            destroyPhysical(options.getDevice?.(), candidatePhysical.get(target as object));
            candidatePhysical.delete(target as object);
            continue;
          }
          // A progressive CubeCamera writes several faces into one physical
          // candidate across multiple submissions. Do not publish that
          // partially-written generation as active: the next face would then
          // bind the same texture as both a sampled source and an attachment.
          // Keep the target in the staged queue so the next accepted frame (or
          // this same completion callback after the final face) retries the
          // publication check.
          if (options.canPromoteTarget?.(target) === false) {
            staged.add(target);
            continue;
          }
          const generation = candidate.value.candidate.generation;
          const physical = candidatePhysical.get(target as object);
          if (physical === undefined) {
            owner.rejectCandidate(target, generation, 'submit');
            continue;
          }
          const promoted = owner.promote(target, generation);
          if (!promoted.ok) {
            destroyPhysical(options.getDevice?.(), physical);
            candidatePhysical.delete(target as object);
            continue;
          }
          const previous = activePhysical.get(target as object);
          activePhysical.set(target as object, physical as RenderTargetPhysical);
          candidatePhysical.delete(target as object);
          destroyPhysical(options.getDevice?.(), previous);
        }
      });
    },
    getPhysicalTarget(target: RenderTarget): RenderTargetPhysical | undefined {
      return candidatePhysical.get(target as object) ?? activePhysical.get(target as object);
    },
    encodePendingReadbacks(encoder: RhiCommandEncoder, faces?: readonly number[]): void {
      for (const record of readbackRecords) {
        if (record.encoded || record.buffer === undefined) continue;
        if (
          faces !== undefined &&
          record.ticket.face !== undefined &&
          !faces.includes(record.ticket.face)
        ) {
          continue;
        }
        const candidate = candidatePhysical.get(record.target as object);
        const physical =
          faces !== undefined &&
          candidate !== undefined &&
          record.ticket.face !== undefined &&
          faces.includes(record.ticket.face)
            ? candidate
            : activePhysical.get(record.target as object);
        if (physical === undefined) continue;
        const source = physical.resolveTexture ?? physical.texture;
        encoder.copyTextureToBuffer(
          {
            texture: source,
            mipLevel: record.ticket.mipLevel,
            origin: { x: 0, y: 0, z: record.ticket.face ?? 0 },
          },
          {
            buffer: record.buffer,
            bytesPerRow: record.ticket.bytesPerRow,
            rowsPerImage: record.ticket.height,
          },
          [record.ticket.width, record.ticket.height, 1],
        );
        record.encoded = true;
      }
    },
    recover(): void {
      if (disposed) return;
      const generation = currentGeneration();
      for (const target of targets) {
        const inspected = owner.inspect(target);
        if (!inspected.ok || inspected.value.state !== 'active') continue;
        destroyPhysical(options.getDevice?.(), activePhysical.get(target as object));
        destroyPhysical(options.getDevice?.(), candidatePhysical.get(target as object));
        activePhysical.delete(target as object);
        candidatePhysical.delete(target as object);
        for (const record of readbackRecords) {
          if (record.target !== target) continue;
          if (record.buffer !== undefined) options.getDevice?.()?.destroyBuffer(record.buffer);
          readbacks.delete(record.ticket as object);
          readbackRecords.delete(record);
        }
        const begun = owner.beginRecovery(target, generation);
        if (begun.ok) owner.finishRecovery(target);
      }
    },
    dispose(): void {
      disposed = true;
      for (const target of [...targets]) {
        destroyPhysical(options.getDevice?.(), activePhysical.get(target as object));
        destroyPhysical(options.getDevice?.(), candidatePhysical.get(target as object));
        for (const record of readbackRecords) {
          if (record.target !== target) continue;
          if (record.buffer !== undefined) options.getDevice?.()?.destroyBuffer(record.buffer);
          readbacks.delete(record.ticket as object);
          readbackRecords.delete(record);
        }
        activePhysical.delete(target as object);
        candidatePhysical.delete(target as object);
        owner.destroy(target);
      }
      targets.clear();
      staged.clear();
      readbackRecords.clear();
    },
  });
}
