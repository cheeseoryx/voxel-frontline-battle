import type { RhiDevice, Texture, TextureView } from '@forgeax/engine-rhi';
import { createShaderModule, rhi } from '@forgeax/engine-rhi-webgpu';
import { buildEngineShaderManifest } from '@forgeax/engine-vite-plugin-shader';
import { describe, expect, it } from 'vitest';
import { BYTES_PER_DIRECT_LIGHT_SLOT } from '../light-buffer-layout';

const MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const TEXTURE_COPY_SRC = 0x0001;
const TEXTURE_COPY_DST = 0x0002;
const STORAGE_BINDING = 0x0008;
const TEXTURE_BINDING = 0x0004;
const RENDER_ATTACHMENT = 0x0010;
const STORAGE_BUFFER = 0x0080;
const SIZE = 8;
const PACKED_LAYERS = Math.ceil(SIZE / 4);
const BYTES_PER_ROW = 256;
const BYTES_PER_PIXEL = 8;
const MAX_CLUSTER_LIGHTS = 256;
const CLUSTER_LIGHT_DATA_BYTES = MAX_CLUSTER_LIGHTS * BYTES_PER_DIRECT_LIGHT_SLOT;
const CLUSTER_UNIFORM_BYTES = 32;
const engineManifest = await buildEngineShaderManifest();

interface StageValues {
  readonly red: number[];
  readonly green: number[];
  readonly alpha: number[];
}

interface VolumeStageReadbacks {
  readonly inject: StageValues;
  readonly temporal: StageValues;
  readonly integrate: StageValues;
}

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x3ff;
  if (exponent === 0) return sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

function manifestShader(marker: string): string {
  const entry = engineManifest.entries.find(({ wgsl }) => wgsl.includes(marker));
  if (entry === undefined) throw new Error(`missing cooked shader entry: ${marker}`);
  return entry.wgsl;
}

function identityMatrix(target: Float32Array, offset: number): void {
  target[offset] = 1;
  target[offset + 5] = 1;
  target[offset + 10] = 1;
  target[offset + 15] = 1;
}

function createView(
  device: RhiDevice,
  texture: Texture,
  dimension?: '2d' | '2d-array' | '3d',
): TextureView {
  const view = device.createTextureView(texture, dimension === undefined ? {} : { dimension });
  if (!view.ok) throw view.error;
  return view.value;
}

async function requestDevice(): Promise<RhiDevice> {
  const adapter = await rhi.requestAdapter();
  if (!adapter.ok) throw new Error(`Dawn volume stage readback unavailable: ${adapter.error.code}`);
  const device = await adapter.value.requestDevice();
  if (!device.ok) throw new Error(`Dawn volume stage readback unavailable: ${device.error.code}`);
  return device.value;
}

async function runInjectReadback(sceneDepthClear = 1): Promise<VolumeStageReadbacks> {
  const device = await requestDevice();
  const moduleResult = await createShaderModule(device, {
    code: manifestShader('fn volume_inject'),
    label: 'stage-readback.volume-inject',
  });
  if (!moduleResult.ok) throw moduleResult.error;
  const temporalModule = await createShaderModule(device, {
    code: manifestShader('fn volume_temporal'),
    label: 'stage-readback.volume-temporal',
  });
  const integrateModule = await createShaderModule(device, {
    code: manifestShader('fn volume_integrate'),
    label: 'stage-readback.volume-integrate',
  });
  if (!temporalModule.ok) throw temporalModule.error;
  if (!integrateModule.ok) throw integrateModule.error;

  const sceneDepthTexture = device.createTexture({
    label: 'stage-readback.scene-depth',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
    format: 'depth32float',
    usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
    textureBindingViewDimension: undefined,
  });
  const shadowTexture = device.createTexture({
    label: 'stage-readback.shadow-depth',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
    format: 'depth32float',
    usage: RENDER_ATTACHMENT | TEXTURE_BINDING,
    textureBindingViewDimension: undefined,
  });
  const densityTexture = device.createTexture({
    label: 'stage-readback.density',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: SIZE },
    dimension: '3d',
    format: 'rgba8unorm',
    usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
    textureBindingViewDimension: undefined,
  });
  const outputTexture = device.createTexture({
    label: 'stage-readback.froxel',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: PACKED_LAYERS },
    dimension: '2d',
    format: 'rgba8unorm',
    usage: STORAGE_BINDING | TEXTURE_COPY_SRC | TEXTURE_BINDING,
    textureBindingViewDimension: undefined,
  });
  const historyTexture = device.createTexture({
    label: 'stage-readback.history',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
    dimension: '2d',
    format: 'rgba16float',
    usage: STORAGE_BINDING | TEXTURE_COPY_SRC | TEXTURE_BINDING,
    textureBindingViewDimension: undefined,
  });
  const temporalTexture = device.createTexture({
    label: 'stage-readback.temporal',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
    dimension: '2d',
    format: 'rgba16float',
    usage: STORAGE_BINDING | TEXTURE_COPY_SRC | TEXTURE_BINDING,
    textureBindingViewDimension: undefined,
  });
  const resolvedTexture = device.createTexture({
    label: 'stage-readback.resolved',
    size: { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
    dimension: '2d',
    format: 'rgba16float',
    usage: STORAGE_BINDING | TEXTURE_COPY_SRC | TEXTURE_BINDING,
    textureBindingViewDimension: undefined,
  });
  // The production integrator always declares the shared projector pair. A
  // white 1x1 fallback keeps this no-projector fixture on the same BGL shape
  // while preserving the pre-projector radiance when a light is later added.
  const projectorTexture = device.createTexture({
    label: 'stage-readback.projector',
    size: { width: 1, height: 1, depthOrArrayLayers: 1 },
    dimension: '2d',
    format: 'rgba8unorm',
    usage: TEXTURE_BINDING | TEXTURE_COPY_DST,
    textureBindingViewDimension: undefined,
  });
  if (
    !sceneDepthTexture.ok ||
    !shadowTexture.ok ||
    !densityTexture.ok ||
    !outputTexture.ok ||
    !historyTexture.ok ||
    !temporalTexture.ok ||
    !resolvedTexture.ok ||
    !projectorTexture.ok
  ) {
    throw new Error('Dawn volume stage readback unavailable: texture allocation failed');
  }
  const sceneDepthView = device.createTextureView(sceneDepthTexture.value, { dimension: '2d' });
  const shadowView = device.createTextureView(shadowTexture.value, { dimension: '2d' });
  if (!sceneDepthView.ok || !shadowView.ok)
    throw new Error('Dawn volume stage readback unavailable: depth view allocation failed');
  const densityView = createView(device, densityTexture.value, '3d');
  const outputView = createView(device, outputTexture.value, '2d-array');
  const historyView = createView(device, historyTexture.value, '2d');
  const temporalView = createView(device, temporalTexture.value, '2d');
  const resolvedView = createView(device, resolvedTexture.value, '2d');
  const projectorView = createView(device, projectorTexture.value, '2d');
  const viewBuffer = device.createBuffer({
    label: 'stage-readback.view',
    size: 960,
    usage: 0x0040 | BUFFER_COPY_DST,
  });
  const paramsBuffer = device.createBuffer({
    label: 'stage-readback.params',
    size: 128,
    usage: 0x0040 | BUFFER_COPY_DST,
  });
  const lightDataBuffer = device.createBuffer({
    label: 'stage-readback.cluster-light-data',
    size: CLUSTER_LIGHT_DATA_BYTES,
    usage: STORAGE_BUFFER | BUFFER_COPY_DST,
  });
  const clusterUniformBuffer = device.createBuffer({
    label: 'stage-readback.cluster-uniform',
    size: CLUSTER_UNIFORM_BYTES,
    usage: 0x0040 | BUFFER_COPY_DST,
  });
  const injectReadback = device.createBuffer({
    label: 'stage-readback.inject',
    size: BYTES_PER_ROW * SIZE * PACKED_LAYERS,
    usage: MAP_READ | BUFFER_COPY_DST,
  });
  const temporalReadback = device.createBuffer({
    label: 'stage-readback.temporal',
    size: BYTES_PER_ROW * SIZE * SIZE,
    usage: MAP_READ | BUFFER_COPY_DST,
  });
  const integrateReadback = device.createBuffer({
    label: 'stage-readback.integrate',
    size: BYTES_PER_ROW * SIZE * SIZE,
    usage: MAP_READ | BUFFER_COPY_DST,
  });
  if (
    !viewBuffer.ok ||
    !paramsBuffer.ok ||
    !lightDataBuffer.ok ||
    !clusterUniformBuffer.ok ||
    !injectReadback.ok ||
    !temporalReadback.ok ||
    !integrateReadback.ok
  )
    throw new Error('Dawn volume stage readback unavailable: readback allocation failed');

  const viewData = new Float32Array(240);
  for (const offset of [0, 28, 44, 60, 76, 92, 196, 212]) identityMatrix(viewData, offset);
  viewData[24] = 0;
  viewData[25] = 0;
  viewData[26] = -1;
  viewData[124] = 0;
  viewData[228] = 0.1;
  viewData[229] = 10;
  viewData[230] = 0;
  viewData[235] = 1;
  const paramsData = new Float32Array(32);
  paramsData.set([-1, -1, 0.1, 0], 0);
  paramsData.set([1, 1, 0.9, 0], 4);
  paramsData.set([1, 1, 1, 0], 8);
  paramsData.set([1, 1, 1, 0], 12);
  paramsData.set([0, 0, 0, 0], 16);
  paramsData.set([0, -1, 0, 0], 20);
  paramsData.set([1, 1, 1, 0], 24);
  paramsData.set([2, 0, 0, 0], 28);
  const lightData = new Uint8Array(CLUSTER_LIGHT_DATA_BYTES);
  const clusterUniformData = new Float32Array(8);
  const clusterGrid = new Uint32Array(clusterUniformData.buffer);
  clusterGrid[0] = 1;
  clusterGrid[1] = 1;
  clusterGrid[2] = 1;
  clusterGrid[3] = 1;
  const viewWrite = device.queue.writeBuffer(viewBuffer.value, 0, viewData);
  const paramsWrite = device.queue.writeBuffer(paramsBuffer.value, 0, paramsData);
  const lightDataWrite = device.queue.writeBuffer(lightDataBuffer.value, 0, lightData);
  const clusterUniformWrite = device.queue.writeBuffer(
    clusterUniformBuffer.value,
    0,
    clusterUniformData,
  );
  if (!viewWrite.ok || !paramsWrite.ok || !lightDataWrite.ok || !clusterUniformWrite.ok)
    throw new Error('Dawn volume stage readback unavailable: uniform upload failed');
  const densityData = new Uint8Array((BYTES_PER_PIXEL / 2) * SIZE * SIZE * SIZE);
  densityData.fill(255);
  const densityWrite = device.queue.writeTexture(
    { texture: densityTexture.value },
    densityData,
    { offset: 0, bytesPerRow: SIZE * 4, rowsPerImage: SIZE },
    { width: SIZE, height: SIZE, depthOrArrayLayers: SIZE },
  );
  if (!densityWrite.ok)
    throw new Error('Dawn volume stage readback unavailable: density upload failed');
  const projectorWrite = device.queue.writeTexture(
    { texture: projectorTexture.value },
    new Uint8Array([255, 255, 255, 255]),
    { bytesPerRow: 4, rowsPerImage: 1 },
    { width: 1, height: 1, depthOrArrayLayers: 1 },
  );
  if (!projectorWrite.ok)
    throw new Error('Dawn volume stage readback unavailable: projector upload failed');

  const layout = device.createBindGroupLayout({
    label: 'stage-readback.volume-inject.layout',
    entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 3, visibility: 4, texture: { sampleType: 'depth', viewDimension: '2d' } },
      { binding: 4, visibility: 4, sampler: { type: 'comparison' } },
      { binding: 5, visibility: 4, buffer: { type: 'uniform' } },
      {
        binding: 6,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba8unorm', viewDimension: '2d-array' },
      },
      { binding: 7, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 8, visibility: 4, buffer: { type: 'uniform' } },
    ],
  });
  if (!layout.ok) throw layout.error;
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout.value] });
  if (!pipelineLayout.ok) throw pipelineLayout.error;
  const pipeline = device.createComputePipeline({
    label: 'stage-readback.volume-inject',
    layout: pipelineLayout.value,
    compute: { module: moduleResult.value, entryPoint: 'volume_inject' },
  });
  if (!pipeline.ok) throw pipeline.error;
  const temporalLayout = device.createBindGroupLayout({
    label: 'stage-readback.volume-temporal.layout',
    entries: [
      {
        binding: 0,
        visibility: 4,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      {
        binding: 1,
        visibility: 4,
        texture: { sampleType: 'float', viewDimension: '2d' },
      },
      {
        binding: 2,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
      { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
    ],
  });
  const integrateLayout = device.createBindGroupLayout({
    label: 'stage-readback.volume-integrate.layout',
    entries: [
      { binding: 0, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d-array' } },
      {
        binding: 1,
        visibility: 4,
        texture: { sampleType: 'depth', viewDimension: '2d' },
      },
      {
        binding: 2,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
      { binding: 3, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 4, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 5, visibility: 4, sampler: { type: 'filtering' } },
      { binding: 6, visibility: 4, texture: { sampleType: 'float', viewDimension: '3d' } },
      { binding: 7, visibility: 4, sampler: { type: 'filtering' } },
      {
        binding: 8,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
      {
        binding: 9,
        visibility: 4,
        storageTexture: { access: 'write-only', format: 'rgba16float', viewDimension: '2d' },
      },
      { binding: 10, visibility: 4, buffer: { type: 'read-only-storage' } },
      { binding: 11, visibility: 4, buffer: { type: 'uniform' } },
      { binding: 12, visibility: 4, texture: { sampleType: 'float', viewDimension: '2d' } },
      { binding: 13, visibility: 4, sampler: { type: 'filtering' } },
    ],
  });
  if (!temporalLayout.ok) throw temporalLayout.error;
  if (!integrateLayout.ok) throw integrateLayout.error;
  const temporalPipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [temporalLayout.value],
  });
  const integratePipelineLayout = device.createPipelineLayout({
    bindGroupLayouts: [integrateLayout.value],
  });
  if (!temporalPipelineLayout.ok) throw temporalPipelineLayout.error;
  if (!integratePipelineLayout.ok) throw integratePipelineLayout.error;
  const temporalPipeline = device.createComputePipeline({
    label: 'stage-readback.volume-temporal',
    layout: temporalPipelineLayout.value,
    compute: { module: temporalModule.value, entryPoint: 'volume_temporal' },
  });
  const integratePipeline = device.createComputePipeline({
    label: 'stage-readback.volume-integrate',
    layout: integratePipelineLayout.value,
    compute: { module: integrateModule.value, entryPoint: 'volume_integrate' },
  });
  if (!temporalPipeline.ok) throw temporalPipeline.error;
  if (!integratePipeline.ok) throw integratePipeline.error;
  const comparisonSampler = device.createSampler({ compare: 'less' });
  const densitySampler = device.createSampler({ minFilter: 'linear', magFilter: 'linear' });
  if (!comparisonSampler.ok || !densitySampler.ok)
    throw new Error('Dawn volume stage readback unavailable: sampler allocation failed');
  const bindings = device.createBindGroup({
    layout: layout.value,
    entries: [
      { binding: 0, resource: { kind: 'buffer', value: { buffer: viewBuffer.value } } },
      { binding: 3, resource: { kind: 'textureView', value: shadowView.value } },
      { binding: 4, resource: { kind: 'sampler', value: comparisonSampler.value } },
      { binding: 5, resource: { kind: 'buffer', value: { buffer: paramsBuffer.value } } },
      { binding: 6, resource: { kind: 'textureView', value: outputView } },
      { binding: 7, resource: { kind: 'buffer', value: { buffer: lightDataBuffer.value } } },
      { binding: 8, resource: { kind: 'buffer', value: { buffer: clusterUniformBuffer.value } } },
    ],
  });
  if (!bindings.ok) throw bindings.error;
  const temporalBindings = device.createBindGroup({
    layout: temporalLayout.value,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: resolvedView } },
      { binding: 1, resource: { kind: 'textureView', value: historyView } },
      { binding: 2, resource: { kind: 'textureView', value: temporalView } },
      { binding: 3, resource: { kind: 'buffer', value: { buffer: paramsBuffer.value } } },
      { binding: 4, resource: { kind: 'buffer', value: { buffer: viewBuffer.value } } },
    ],
  });
  const integrateBindings = device.createBindGroup({
    layout: integrateLayout.value,
    entries: [
      { binding: 0, resource: { kind: 'textureView', value: outputView } },
      { binding: 1, resource: { kind: 'textureView', value: sceneDepthView.value } },
      { binding: 2, resource: { kind: 'textureView', value: resolvedView } },
      { binding: 3, resource: { kind: 'buffer', value: { buffer: paramsBuffer.value } } },
      { binding: 4, resource: { kind: 'buffer', value: { buffer: viewBuffer.value } } },
      { binding: 5, resource: { kind: 'sampler', value: densitySampler.value } },
      { binding: 6, resource: { kind: 'textureView', value: densityView } },
      { binding: 7, resource: { kind: 'sampler', value: densitySampler.value } },
      { binding: 8, resource: { kind: 'textureView', value: historyView } },
      { binding: 9, resource: { kind: 'textureView', value: temporalView } },
      { binding: 10, resource: { kind: 'buffer', value: { buffer: lightDataBuffer.value } } },
      { binding: 11, resource: { kind: 'buffer', value: { buffer: clusterUniformBuffer.value } } },
      { binding: 12, resource: { kind: 'textureView', value: projectorView } },
      { binding: 13, resource: { kind: 'sampler', value: densitySampler.value } },
    ],
  });
  if (!temporalBindings.ok) throw temporalBindings.error;
  if (!integrateBindings.ok) throw integrateBindings.error;
  const encoder = device.createCommandEncoder({ label: 'stage-readback.volume-inject' });
  if (!encoder.ok) throw encoder.error;
  for (const [index, view] of [sceneDepthView.value, shadowView.value].entries()) {
    const pass = encoder.value.beginRenderPass({
      colorAttachments: [],
      depthStencilAttachment: {
        view,
        depthClearValue: index === 0 ? sceneDepthClear : 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    } as never);
    pass.end();
  }
  const compute = encoder.value.beginComputePass();
  compute.setPipeline(pipeline.value);
  compute.setBindGroup(0, bindings.value);
  compute.dispatchWorkgroups(1, 1, PACKED_LAYERS);
  compute.end();
  encoder.value.copyTextureToBuffer(
    { texture: outputTexture.value as never },
    { buffer: injectReadback.value as never, bytesPerRow: BYTES_PER_ROW, rowsPerImage: SIZE },
    { width: SIZE, height: SIZE, depthOrArrayLayers: PACKED_LAYERS },
  );
  const integrateCompute = encoder.value.beginComputePass();
  integrateCompute.setPipeline(integratePipeline.value);
  integrateCompute.setBindGroup(0, integrateBindings.value);
  integrateCompute.dispatchWorkgroups(1, 1, 1);
  integrateCompute.end();
  encoder.value.copyTextureToBuffer(
    { texture: resolvedTexture.value as never },
    { buffer: integrateReadback.value as never, bytesPerRow: BYTES_PER_ROW, rowsPerImage: SIZE },
    { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
  );
  const temporalCompute = encoder.value.beginComputePass();
  temporalCompute.setPipeline(temporalPipeline.value);
  temporalCompute.setBindGroup(0, temporalBindings.value);
  temporalCompute.dispatchWorkgroups(1, 1, 1);
  temporalCompute.end();
  encoder.value.copyTextureToBuffer(
    { texture: temporalTexture.value as never },
    { buffer: temporalReadback.value as never, bytesPerRow: BYTES_PER_ROW, rowsPerImage: SIZE },
    { width: SIZE, height: SIZE, depthOrArrayLayers: 1 },
  );
  const command = encoder.value.finish();
  if (!command.ok) throw command.error;
  const submitted = device.queue.submit([command.value]);
  if (!submitted.ok) throw submitted.error;
  await device.queue.onSubmittedWorkDone();
  const decode = async (
    buffer: typeof integrateReadback.value,
    layers: number,
    bytesPerPixel: number,
    halfFloat: boolean,
  ): Promise<StageValues> => {
    const mapped = await buffer.mapAsync(MAP_READ);
    if (!mapped.ok) throw mapped.error;
    const range = mapped.value.getMappedRange();
    if (!range.ok) throw range.error;
    const bytes = new Uint8Array(range.value);
    const red: number[] = [];
    const green: number[] = [];
    const alpha: number[] = [];
    for (let z = 0; z < layers; z += 1) {
      for (let y = 0; y < SIZE; y += 1) {
        for (let x = 0; x < SIZE; x += 1) {
          const offset = z * BYTES_PER_ROW * SIZE + y * BYTES_PER_ROW + x * bytesPerPixel;
          const read = (channel: number): number => {
            if (!halfFloat) return (bytes[offset + channel] ?? 0) / 255;
            const halfOffset = offset + channel * 2;
            return halfToFloat((bytes[halfOffset] ?? 0) | ((bytes[halfOffset + 1] ?? 0) << 8));
          };
          red.push(read(0));
          green.push(read(halfFloat ? 1 : 1));
          alpha.push(read(halfFloat ? 3 : 3));
        }
      }
    }
    mapped.value.unmap();
    return { red, green, alpha };
  };
  return {
    inject: await decode(injectReadback.value, SIZE, 4, false),
    temporal: await decode(temporalReadback.value, 1, BYTES_PER_PIXEL, true),
    integrate: await decode(integrateReadback.value, 1, BYTES_PER_PIXEL, true),
  };
}

describe('volumetric fog production stage readback on Dawn', () => {
  it('injects raw density then resolves a 2d integrated volume', async () => {
    const values = await runInjectReadback();
    // biome-ignore lint/suspicious/noConsole: stage readback is machine evidence
    console.log(
      JSON.stringify({
        inject: [Math.min(...values.inject.red), Math.max(...values.inject.red)],
        temporal: [Math.min(...values.temporal.red), Math.max(...values.temporal.red)],
        integrate: [Math.min(...values.integrate.red), Math.max(...values.integrate.red)],
      }),
    );
    expect(values.inject.red.filter((value) => value > 0.01).length).toBeGreaterThan(0);
    expect(values.inject.green.some((value) => value > 0.9)).toBe(true);
    expect(values.inject.green.every((value) => value >= 0 && value <= 1)).toBe(true);
    expect(values.temporal.red.some((value) => value > 0)).toBe(true);
    expect(values.temporal.alpha.every((value) => value <= 1)).toBe(true);
    expect(values.integrate.red.some((value) => value > 0)).toBe(true);
    expect(values.integrate.alpha.every((value) => value >= 0 && value <= 1)).toBe(true);
  });

  it('clips the final ray step to the scene-depth segment', async () => {
    const values = await runInjectReadback(0.57);
    const transmittance = values.integrate.alpha[0];
    // The fixture uploads an all-white source texture. The authored Three
    // smoke expression therefore evaluates to 2 * 1.5^3 - 1 = 5.75 before
    // Beer-Lambert consumes it; only the final 0.47-unit segment is allowed
    // to contribute after the scene-depth clip.
    const sourceDensity = 2 * 1.5 ** 3 - 1;
    expect(transmittance).toBeCloseTo(Math.exp(-0.47 * sourceDensity), 2);
    expect(values.integrate.red[0]).toBeGreaterThan(0);
  });
});
