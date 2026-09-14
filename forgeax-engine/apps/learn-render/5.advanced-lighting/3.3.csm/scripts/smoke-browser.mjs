// smoke-browser.mjs -- RHI-debug capture pixel-parity verification for
// learn-render 5.x csm (3.3.csm). Delegates to the shared harness; supplies
// demo identity + live-pixel hook (window.__captureCsm, installed by
// src/main.ts).
// Local-only gate (no Chrome+WebGPU on CI runners).

import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../../shared/scripts/rhi-debug-verify.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const MVD_PROFILE = process.env.CSM_MVD_PROFILE ?? 'pcf3';
const MVD_SCENE = process.env.CSM_MVD_SCENE ?? 'near';
const GPU_TIMING_RECEIPT = {
  status: 'not-run',
  reason: 'shared Browser capture does not provide a Render-owned GPU timestamp receipt; page wall time and RhiNull are not substitutes.',
};
const MVD_FALSIFIERS = Object.freeze({
  'force-csm-fixed-radius': { ac: 'AC-04', expectation: 'world-scale penumbra must vary with blocker distance', repair: 'restore receiver-derived angular radius' },
  'force-csm-clear-blocker-raw': { ac: 'AC-05', expectation: 'raw blocker depth must remain observable', repair: 'restore raw blocker depth reads' },
  'force-csm-remove-tile-clamp': { ac: 'AC-07', expectation: 'integer inset and tile clamp must protect atlas edges', repair: 'restore shared shadow-pcf tile clamp' },
  'force-csm-capable-backend-pcf': { ac: 'AC-09', expectation: 'capable WebGPU must retain the requested PCSS profile', repair: 'remove the forced PCF fallback' },
  'force-csm-webgl2-pcss-effective': { ac: 'AC-10', expectation: 'WebGL2 must expose fixed PCF3/PCF5, never effective PCSS', repair: 'keep WebGL2 mapping explicit and bounded' },
  'force-csm-pcf5-pretends-pcss': { ac: 'AC-14', expectation: 'PCF5 must not claim PCSS blocker/filter semantics', repair: 'restore the closed profile identity' },
  'force-csm-shadow-off-build-pass': { ac: 'AC-15', expectation: 'shadow-off must remove the shadow pass', repair: 'keep shadow-off topology fail-closed' },
});
const mvdFalsifier = MVD_FALSIFIERS[process.env.FALSIFY];

console.log(`[csm] AC-16=${GPU_TIMING_RECEIPT.status} reason=${GPU_TIMING_RECEIPT.reason}`);

function buildUrlSuffix() {
  const params = new URLSearchParams({
    'mvd-profile': MVD_PROFILE,
    'mvd-scene': MVD_SCENE,
  });
  const falsifierQueries = {
    'force-csm-fixed-radius': ['mvd-falsify', 'force-csm-fixed-radius'],
    'force-csm-clear-blocker-raw': ['mvd-falsify', 'force-csm-clear-blocker-raw'],
    'force-csm-remove-tile-clamp': ['mvd-falsify', 'force-csm-remove-tile-clamp'],
    'force-csm-capable-backend-pcf': ['mvd-falsify', 'force-csm-capable-backend-pcf'],
    'force-csm-webgl2-pcss-effective': ['mvd-falsify', 'force-csm-webgl2-pcss-effective'],
    'force-csm-pcf5-pretends-pcss': ['mvd-falsify', 'force-csm-pcf5-pretends-pcss'],
    'force-csm-shadow-off-build-pass': ['mvd-falsify', 'force-csm-shadow-off-build-pass'],
    'force-csm-highlight-layer-2': ['csm-highlight', '2'],
    'force-csm-browser-probe-boundary-shift': ['csm-probe-boundary-shift', '1'],
    'force-csm-browser-probe-boundary-depth-shift': ['csm-probe-boundary-depth-shift', '1'],
    'force-csm-browser-probe-boundary-factor-shift': ['csm-probe-boundary-factor-shift', '1'],
    'force-csm-browser-probe-shadow-depth-shift': ['csm-probe-shadow-depth-shift', '1'],
  };
  const query = falsifierQueries[process.env.FALSIFY];
  if (query !== undefined) params.set(query[0], query[1]);
  return `?${params.toString()}`;
}

const CSM_ATLAS_TILE_SIZE = 2048;
const CSM_ATLAS_TILES_PER_SIDE = 2;
const CSM_SCENE_SHADOW_DISTANCE = Object.freeze({
  near: 18,
  far: 50,
  seam: 50,
  motion: 32,
  alpha: 26,
  transparent: 38,
  fallback: 50,
});

function expectedCsmSplits() {
  const nearPlane = 0.1;
  const farPlane = CSM_SCENE_SHADOW_DISTANCE[MVD_SCENE] ?? 50;
  const splitLambda = 0.75;
  const cascadeCount = 4;
  const ratio = farPlane / nearPlane;
  return Array.from({ length: cascadeCount }, (_, index) => {
    const t = (index + 1) / cascadeCount;
    const logPart = nearPlane * ratio ** t;
    const uniformPart = nearPlane + t * (farPlane - nearPlane);
    return Math.fround(splitLambda * logPart + (1 - splitLambda) * uniformPart);
  });
}

await verifyDemoCapture({
  pkg: '@forgeax/app-learn-render-5-advanced-lighting-3-3-csm',
  label: 'learn-render 5.3.3 csm',
  mode: 'pixel',
  liveHook: '__captureCsm',
  browserReplayHook: '__replayCsmCapture',
  pixelVerdictOwner: 'browser-fresh',
  capturePrepareHook: '__prepareCsmCapture',
  rtIdx: 0,
  appDir: dirname(here),
  warmupMs: Number.parseInt(process.env.CSM_BROWSER_WARMUP_MS ?? '10000', 10),
  navigationWaitUntil: 'domcontentloaded',
  assertCapture: assertCsmCapture,
  assertTape: assertCsmTape,
  assertPixels: assertCsmPixels,
  urlSuffix: buildUrlSuffix(),
});

/** @param {object} report */
function assertCsmCapture(report) {
  const header = report.header ?? {};
  const bootstrap = report.bootstrap ?? {};
  console.log(
    `[csm-mvd] browser structural receipt=${JSON.stringify({
      binding: {
        profile: MVD_PROFILE,
        scene: MVD_SCENE,
        backend: header.backendKind ?? bootstrap.backendKind ?? null,
        deviceGeneration: Number.isSafeInteger(header.deviceGeneration) ? header.deviceGeneration : null,
        graphGeneration: Number.isSafeInteger(header.graphGeneration) ? header.graphGeneration : null,
      },
      observed: 'single RHI-debug tape plus shared live-capture route',
      verdict: 'not-run',
      confidence: 'low',
      notes: 'Keep generation null when the capture header is incomplete; do not fabricate a paired visual pass.',
    })}`,
  );
  const events = [
    ...Object.values(report.bootstrap ?? {})
      .map((entry) => entry?.create)
      .filter((event) => typeof event?.kind === 'string'),
    ...report.events,
  ];
  const passes = csmCascadePasses(events);
  if (passes.length !== 4) {
    throw new Error(`expected 4 depth-only cascade passes, got ${passes.length}`);
  }
  const depthViews = new Set(passes.map((pass) => pass.depthStencilViewHandleId));
  if (depthViews.size !== 1) {
    throw new Error(`expected one shared cascade atlas view, got ${[...depthViews].join(', ')}`);
  }
  const depthViewId = passes[0].depthStencilViewHandleId;
  const depthView = events.find(
    (event) => event.kind === 'createTextureView' && event.resultHandleId === depthViewId,
  );
  const depthTexture = events.find(
    (event) => event.kind === 'createTexture' && event.handleId === depthView?.sourceHandleId,
  );
  const size = depthTexture?.desc?.size;
  if (
    depthTexture?.desc?.format !== 'depth32float' ||
    size?.width !== 4096 ||
    size?.height !== 4096 ||
    size?.depthOrArrayLayers !== 1
  ) {
    throw new Error(`cascade atlas lineage is not 4096x4096 depth32float: ${JSON.stringify(depthTexture?.desc)}`);
  }
  assertCsmAtlasTileViewports(events, passes);
  if (process.env.FALSIFY === 'force-csm-webgl2-pcss-effective') {
    const actualBackend = header.backendKind ?? bootstrap.backendKind ?? null;
    if (actualBackend !== 'wgpu-webgl2') {
      throw new Error(`WebGL2 falsifier changed the expected backend fixture but observed ${actualBackend}`);
    }
  }
  if (process.env.FALSIFY === 'force-csm-shadow-off-build-pass' && passes.length === 4) {
    throw new Error('shadow-off falsifier left all four directional cascade passes in the tape');
  }
  for (const pass of passes) {
    const begin = events.indexOf(pass);
    const end = events.findIndex((event, index) => index > begin && event.kind === 'endRenderPass');
    const body = events.slice(begin, end < 0 ? events.length : end);
    if (body.filter((event) => event.kind === 'drawIndexed').length < 10) {
      throw new Error(`cascade pass at event ${begin} did not record scene indexed draws`);
    }
  }
  const sceneDepthBgl = events.find(
    (event) =>
      event.kind === 'createBindGroupLayout' &&
      event.desc?.label === 'fullscreen-post-with-scene-depth-bgl',
  );
  const depthEntry = sceneDepthBgl?.desc?.entries?.find((entry) => entry.binding === 3);
  if (depthEntry?.texture?.sampleType !== 'depth' || depthEntry.texture.viewDimension !== '2d') {
    throw new Error('cascade overlay BGL does not declare a 2d depth read');
  }
}

function csmCascadePasses(events) {
  return events.filter(
    (event) =>
      event.kind === 'beginRenderPass' &&
      event.colorAttachmentViewHandleIds.length === 0 &&
      typeof event.depthStencilViewHandleId === 'string' &&
      events.some(
        (candidate) =>
          candidate.kind === 'setViewport' &&
          candidate.passHandleId === event.passHandleId &&
          candidate.w === CSM_ATLAS_TILE_SIZE &&
          candidate.h === CSM_ATLAS_TILE_SIZE,
      ),
  );
}

function resourceIdForBinding(group, binding) {
  const index = group?.entries?.findIndex((entry) => entry.binding === binding) ?? -1;
  return index >= 0 ? group.resourceHandleIds?.[index] : undefined;
}

function assertCsmAtlasTileViewports(events, depthPasses) {
  const actual = depthPasses.map((pass) => {
    const viewport = events.find(
      (event) => event.kind === 'setViewport' && event.passHandleId === pass.passHandleId,
    );
    if (viewport === undefined) {
      throw new Error(`cascade pass ${pass.passHandleId} does not set an atlas viewport`);
    }
    return {
      x: viewport.x,
      y: viewport.y,
      w: viewport.w,
      h: viewport.h,
      minDepth: viewport.minDepth,
      maxDepth: viewport.maxDepth,
    };
  });
  const expected = actual.map((_, index) => ({
    x: (index % CSM_ATLAS_TILES_PER_SIDE) * CSM_ATLAS_TILE_SIZE,
    y: Math.floor(index / CSM_ATLAS_TILES_PER_SIDE) * CSM_ATLAS_TILE_SIZE,
    w: CSM_ATLAS_TILE_SIZE,
    h: CSM_ATLAS_TILE_SIZE,
    minDepth: 0,
    maxDepth: 1,
  }));
  const gated = actual.map((viewport) => ({ ...viewport }));
  if (process.env.FALSIFY === 'force-csm-remove-tile-clamp') {
    gated[3] = { ...gated[3], x: gated[3].x + 1 };
    console.log('[csm] FALSIFY=force-csm-remove-tile-clamp -- shifted cascade edge fixture');
  }
  if (process.env.FALSIFY === 'force-csm-atlas-tile-duplicate') {
    gated[3] = { ...gated[2] };
    console.log('[csm] FALSIFY=force-csm-atlas-tile-duplicate -- duplicated cascade 2 viewport');
  }
  const mismatch = gated.findIndex((viewport, index) =>
    Object.keys(expected[index]).some((key) => viewport[key] !== expected[index][key]),
  );
  if (mismatch >= 0) {
    throw new Error(
      `cascade atlas tile ${mismatch} viewport is not the derived 2x2 layout: ` +
        `${JSON.stringify({ actual: gated, expected })}`,
    );
  }
  console.log(
    `[csm] atlas tiles=${JSON.stringify(actual.map(({ x, y }) => [x, y]))} ` +
      `tileSize=${CSM_ATLAS_TILE_SIZE}`,
  );
}

function assertCsmAtlasSamplerFormula(shaderCode) {
  let gated = shaderCode;
  if (process.env.FALSIFY === 'force-csm-atlas-sampler-tile-formula') {
    gated = gated.replace(
      /let\s+_e\d+\s*=\s*_atlasTileOrigin[^;]+;/,
      'let _e0 = vec2<f32>(0f);',
    );
    console.log(
      '[csm] FALSIFY=force-csm-atlas-sampler-tile-formula -- replaced sampler tile origin',
    );
  }
  const compact = gated.replace(/\s+/g, '');
  const atlasGridStart = compact.indexOf('fn_atlasTileGrid');
  const atlasStart = compact.indexOf('fn_atlasTileOrigin');
  const pcssStart = compact.indexOf('fn_samplePcssForCascade');
  const sampleStart = compact.indexOf('fn_sampleShadowForCascade');
  const sampleEnd = compact.indexOf('fnevalDirectional', sampleStart);
  if (
    atlasGridStart < 0 ||
    atlasStart < atlasGridStart ||
    pcssStart < atlasStart ||
    sampleStart <= atlasStart ||
    sampleEnd <= sampleStart
  ) {
    throw new Error('compiled CSM shader atlas sampler function boundaries are missing');
  }
  const atlasGrid = compact.slice(atlasGridStart, atlasStart);
  const atlasOrigin = compact.slice(atlasStart, pcssStart);
  const pcss = compact.slice(pcssStart, sampleStart);
  const sample = compact.slice(sampleStart, sampleEnd);
  const required = [
    [/fn_atlasTileOrigin[^)]*\)->vec2<f32>/, atlasOrigin],
    // The compact atlas shape is owned by _atlasTileGrid and consumed by
    // _atlasTileOrigin; keep the contract on that helper chain rather than
    // requiring the branch to be duplicated in the consumer.
    [/select\(2u,1u,\(count[^)]*<=1u\)\)/, atlasGrid],
    [/letrows(?:_\d+)?=\(\(\(count[^)]*\+columns\)-1u\)\/columns\);/, atlasGrid],
    [/returnvec2<u32>\(columns[^,]*,rows[^)]*\);/, atlasGrid],
    [/_atlasTileGrid[^;]*\(count[^)]*\);/, atlasOrigin],
    [/layer[^;]*%[^;]*\.x/, atlasOrigin],
    [/layer[^;]*\/[^;]*\.x/, atlasOrigin],
    [/vec2<f32>\(tile[^)]*\)\/vec2<f32>\([^)]*\)/, atlasOrigin],
    [/_atlasTileScale[^;]*\(count[^)]*\);/, sample],
    [/_atlasTileOrigin[^;]*\(layer[^)]*,count[^)]*\);/, sample],
    [/lettileUv[^=]*=vec2<f32>\([^;]*projCoords[^;]*\);/, sample],
    [/letuv[^=]*=\([^;]*tileUv[^;]*\+[^;]*\);/, sample],
    [/lettileLo[^=]*=\([^+;]+\+[^;]+\);/, sample],
    [/lettileHi[^=]*=\(\([^+;]+\+[^)]+\)-[^;]*\);/, sample],
    // Naga may alpha-rename the bounded PCF locals in a composed receiver
    // shader; keep the contract on the clamp operands, not local suffixes.
    [/letoffsetUv(?:_\d+)?=clamp\([^;]*,tileLo(?:_\d+)?,tileHi(?:_\d+)?\);/, sample],
    [/_atlasTileGrid[^;]*\(count[^)]*\);/, pcss],
    [/lettileSize[^=]*=\([^;]*\/[^;]*\);/, pcss],
    // Naga may alpha-rename locals when composing the receiver shader
    // (for example `tileOrigin` -> `tileOrigin_1`).  The contract is the
    // layer/grid arithmetic, not the compiler's collision-avoidance suffix.
    [/lettileOrigin(?:_\d+)?[^=]*=[^;]*%[^;]*\.x/, pcss],
    [/lettileOrigin(?:_\d+)?[^=]*=[^;]*\/[^;]*\.x/, pcss],
  ];
  const missing = required.findIndex(([pattern, source]) => !pattern.test(source));
  if (missing >= 0) {
    throw new Error(`CSM atlas sampler formula is missing source term ${missing}`);
  }
  console.log(
    '[csm] sampler lineage layer->tileOrigin->atlasUv->inTilePcf=accepted',
  );
}

/** @param {{ pixels: Uint8Array, width: number, height: number }} input */
function assertCsmPixels({ pixels, width, height }) {
  let sumRg = 0;
  let sumRgSq = 0;
  let rgCount = 0;
  for (let i = 0; i < width * height; i++) {
    const red = pixels[i * 4] ?? 0;
    const green = pixels[i * 4 + 1] ?? 0;
    if (green > 5) {
      const ratio = red / green;
      sumRg += ratio;
      sumRgSq += ratio * ratio;
      rgCount++;
    }
  }
  const meanRg = rgCount > 0 ? sumRg / rgCount : 0;
  const varianceRg = rgCount > 1 ? sumRgSq / rgCount - meanRg * meanRg : 0;
  const stddevRg = Math.sqrt(Math.max(0, varianceRg));

  const regionAvgRgRatio = (y0, regionHeight) => {
    let redSum = 0;
    let greenSum = 0;
    for (let y = y0; y < y0 + regionHeight; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        redSum += pixels[index] ?? 0;
        greenSum += pixels[index + 1] ?? 0;
      }
    }
    return greenSum > 0 ? redSum / greenSum : 999;
  };
  const stripHeight = Math.floor(height * 0.1);
  const bottomRg = regionAvgRgRatio(Math.floor(height * 0.85), stripHeight);
  const topRg = regionAvgRgRatio(0, stripHeight);
  console.log(
    `[csm] pixel cascade bands meanRg=${meanRg.toFixed(3)} stddevRg=${stddevRg.toFixed(4)} ` +
      `bottomRg=${bottomRg.toFixed(3)} topRg=${topRg.toFixed(3)}`,
  );
  if (process.env.FALSIFY === 'force-csm-clear-blocker-raw' && stddevRg >= 0.35) {
    throw new Error(
      `clear-blocker-raw falsifier did not change the observed depth oracle: stddevRg=${stddevRg.toFixed(4)}`,
    );
  }
  if (process.env.FALSIFY === 'force-csm-highlight-layer-2') {
    if (meanRg >= 1.8 || stddevRg >= 0.45) {
      throw new Error(
        `selected cascade c2 pixel signature is missing: meanRg=${meanRg.toFixed(3)} ` +
          `stddevRg=${stddevRg.toFixed(4)}`,
      );
    }
    if (bottomRg >= topRg - 0.05) {
      throw new Error(
        `selected cascade c2 pixel depth gradient is missing: bottomRg=${bottomRg.toFixed(3)} ` +
          `topRg=${topRg.toFixed(3)}`,
      );
    }
    console.log('[csm] selected cascade c2 pixel signature accepted');
    return;
  }
  if (stddevRg < 0.35) {
    throw new Error(`cascade overlay pixel diversity is too low: stddevRg=${stddevRg.toFixed(4)}`);
  }
  if (bottomRg >= topRg - 0.05) {
    throw new Error(
      `cascade overlay pixel depth gradient is missing: bottomRg=${bottomRg.toFixed(3)} topRg=${topRg.toFixed(3)}`,
    );
  }
  console.log(
    `[csm-mvd] browser visual receipt=${JSON.stringify({
      binding: {
        profile: MVD_PROFILE,
        scene: MVD_SCENE,
        backend: 'webgpu',
        deviceGeneration: null,
        graphGeneration: null,
      },
      pairedReadback: 'shared verifyDemoCapture live/replay comparison',
      png: 'shared verifyDemoCapture .forgeax-debug PNG output',
      observed: {
        width,
        height,
        rgbaSha256: createHash('sha256').update(pixels).digest('hex'),
        meanRg,
        stddevRg,
        bottomRg,
        topRg,
      },
      verdict: 'pass',
      confidence: 'medium',
      notes: 'Keep generation null when the shared Browser harness does not expose it; do not upgrade to complete generation-bound evidence.',
    })}`,
  );
}

/** @param {{ tape: { events: readonly object[], bootstrap?: readonly object[], blobPool: Map<string, ArrayBuffer> } }} input */
function assertCsmTape({ tape }) {
  const events = [
    ...(tape.bootstrap ?? [])
      .map((entry) => entry?.create)
      .filter((event) => typeof event?.kind === 'string'),
    ...tape.events,
  ];
  const depthPasses = csmCascadePasses(events);
  assertCsmAtlasTileViewports(events, depthPasses);
  const depthViewId = depthPasses[0]?.depthStencilViewHandleId;
  const viewBgl = events.find(
    (event) => event.kind === 'createBindGroupLayout' && event.desc?.label === 'pbr-view-bgl',
  );
  const viewGroup = events.find(
    (event) =>
      event.kind === 'createBindGroup' &&
      event.layoutHandleId === viewBgl?.handleId &&
      event.resourceHandleIds?.some((id) => id === depthViewId),
  );
  if (!viewGroup) {
    throw new Error('pbr-view bind group does not retain the cascade depth view');
  }
  const sampledDepthBinding = viewBgl?.desc?.entries?.find((entry) => entry.binding === 3);
  const comparisonSamplerBinding = viewBgl?.desc?.entries?.find((entry) => entry.binding === 4);
  const sampledDepthViewId =
    process.env.FALSIFY === 'force-csm-sampled-depth-resource' ? 'forced-wrong-depth-view' : depthViewId;
  const sampledDepthResourceId = resourceIdForBinding(viewGroup, 3);
  const comparisonSamplerId = resourceIdForBinding(viewGroup, 4);
  const comparisonSampler = events.find(
    (event) => event.kind === 'createSampler' && event.handleId === comparisonSamplerId,
  );
  if (
    sampledDepthBinding?.texture?.sampleType !== 'depth' ||
    sampledDepthBinding.texture.viewDimension !== '2d' ||
    comparisonSamplerBinding?.sampler?.type !== 'comparison' ||
    sampledDepthResourceId !== sampledDepthViewId ||
    typeof comparisonSampler?.desc?.compare !== 'string'
  ) {
    throw new Error(
      `CSM sampled-depth resource lineage is incomplete: ${JSON.stringify({
        sampledDepthBinding,
        comparisonSamplerBinding,
        atlas: sampledDepthResourceId,
        expectedAtlas: sampledDepthViewId,
        comparisonSampler: comparisonSampler?.desc,
      })}`,
    );
  }
  console.log(
    `[csm] sampled-depth resource atlas=${depthViewId} sampler=${comparisonSamplerId} ` +
      `compare=${comparisonSampler.desc.compare} accepted`,
  );
  const cascadeIndexBufferId = resourceIdForBinding(viewGroup, 7);
  const cascadeIndexBuffer = events.find(
    (event) => event.kind === 'createBuffer' && event.handleId === cascadeIndexBufferId,
  );
  const cascadeBinding = viewGroup.entries?.find((entry) => entry.binding === 7);
  const cascadeWrites = events.filter(
    (event) => event.kind === 'writeBuffer' && event.handleId === cascadeIndexBufferId && event.size === 16,
  );
  if (
    cascadeIndexBuffer?.desc?.size !== 2048 ||
    cascadeBinding?.resourceKind !== 'buffer' ||
    cascadeWrites.length < 4
  ) {
    throw new Error(
      `cascade-index UBO lineage is incomplete: ${JSON.stringify({
        buffer: cascadeIndexBuffer?.desc,
        binding: cascadeBinding,
        writes: cascadeWrites.length,
      })}`,
    );
  }
  const readBlob = (hash) => {
    const blob = tape.blobPool.get(hash);
    return blob === undefined ? undefined : new Uint8Array(blob);
  };

  const overlayBglIds = new Set(
    events
      .filter(
        (event) =>
          event.kind === 'createBindGroupLayout' &&
          event.desc?.label === 'fullscreen-post-with-scene-depth-bgl',
      )
      .map((event) => event.handleId),
  );
  const overlayGroup = events.find(
    (event) => event.kind === 'createBindGroup' && overlayBglIds.has(event.layoutHandleId),
  );
  const overlayParamsBufferId = overlayGroup?.resourceHandleIds?.[2];
  const overlayParamsWrite = events.find(
    (event) =>
      event.kind === 'writeBuffer' &&
      event.handleId === overlayParamsBufferId &&
      event.size === 32,
  );
  const overlayParamsBytes =
    overlayParamsWrite === undefined ? undefined : readBlob(overlayParamsWrite.dataHash);
  const overlayTintMode =
    overlayParamsBytes === undefined || overlayParamsBytes.byteLength < 4
      ? undefined
      : new DataView(
          overlayParamsBytes.buffer,
          overlayParamsBytes.byteOffset,
          overlayParamsBytes.byteLength,
        ).getFloat32(0, true);
  const expectedOverlayTintMode =
    process.env.FALSIFY === 'force-csm-highlight-layer-2' ? 2 : 0;
  if (overlayTintMode !== expectedOverlayTintMode) {
    throw new Error(
      `expected CSM overlay tintMode=${expectedOverlayTintMode}, got ${overlayTintMode}`,
    );
  }
  console.log(`[csm] overlay params tintMode=${overlayTintMode}`);
  const overlaySplitBytes = overlayParamsBytes?.slice(16, 32);
  const overlaySplits =
    overlaySplitBytes === undefined
      ? undefined
      : Array.from(new Float32Array(overlaySplitBytes.buffer, overlaySplitBytes.byteOffset, 4));
  const overlayExpectedSplits = expectedCsmSplits();
  if (
    overlaySplits === undefined ||
    overlaySplits.some((value, index) => !Number.isFinite(value) || Math.abs(value - overlayExpectedSplits[index]) > 0.02)
  ) {
    throw new Error(`CSM overlay split params do not match the active scene: ${JSON.stringify({ overlaySplits, expectedSplits: overlayExpectedSplits })}`);
  }
  console.log(`[csm] overlay split params=${JSON.stringify(overlaySplits)} accepted`);

  const selectorValues = cascadeWrites.map((event) => {
    const selectorBytes = readBlob(event.dataHash);
    return selectorBytes === undefined || selectorBytes.byteLength < 4
      ? undefined
      : new DataView(selectorBytes.buffer, selectorBytes.byteOffset, selectorBytes.byteLength).getUint32(0, true);
  });
  const selectorRows = depthPasses.map((pass, expectedIndex) => {
    const begin = events.indexOf(pass);
    const end = events.findIndex(
      (event, index) => index > begin && event.kind === 'endRenderPass',
    );
    const body = events.slice(begin, end < 0 ? events.length : end);
    const shadowViewGroupId = body.find(
      (event) => event.kind === 'setBindGroup' && event.index === 0,
    )?.bindGroupHandleId;
    const shadowViewGroup = events.find(
      (event) => event.kind === 'createBindGroup' && event.handleId === shadowViewGroupId,
    );
    return {
      expectedIndex,
      selector: selectorValues[expectedIndex],
      draws: body.filter((event) => event.kind === 'drawIndexed').length,
      selectorBound: resourceIdForBinding(shadowViewGroup, 7) === cascadeIndexBufferId,
      viewGroupId: shadowViewGroupId,
    };
  });
  const gatedSelectorValues = [...selectorValues];
  if (process.env.FALSIFY === 'force-csm-selector-duplicate') {
    gatedSelectorValues[3] = gatedSelectorValues[2];
    console.log('[csm] FALSIFY=force-csm-selector-duplicate -- duplicated cascade 2 selector');
  }
  if (
    gatedSelectorValues.length !== 4 ||
    gatedSelectorValues.some((value, index) => value !== index) ||
    new Set(selectorRows.map((row) => row.viewGroupId)).size !== 4 ||
    selectorRows.some((row) => row.draws < 10 || !row.selectorBound)
  ) {
    throw new Error(
      `cascade receiver lineage is not ordered 0..3 with bound shadow draws: ${JSON.stringify(selectorRows)}`,
    );
  }

  const receiverPass = events
    .map((event, index) => ({ event, index }))
    .find(({ event, index }) => {
      if (
        event.kind !== 'beginRenderPass' ||
        !event.colorAttachmentViewHandleIds.some((handleId) => typeof handleId === 'string')
      ) {
        return false;
      }
      const end = events.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index && candidate.kind === 'endRenderPass',
      );
      return events
        .slice(index, end < 0 ? events.length : end)
        .some((candidate) => candidate.kind === 'drawIndexed');
    });
  if (receiverPass === undefined) {
    throw new Error('CSM receiver render pass with indexed draws is missing');
  }
  const receiverEnd = events.findIndex(
    (event, index) => index > receiverPass.index && event.kind === 'endRenderPass',
  );
  const receiverBody = events.slice(
    receiverPass.index,
    receiverEnd < 0 ? events.length : receiverEnd,
  );
  const receiverViewBindIndex = receiverBody.findIndex(
    (event) =>
      event.kind === 'setBindGroup' &&
      event.index === 0 &&
      event.bindGroupHandleId === viewGroup.handleId,
  );
  if (
    receiverViewBindIndex < 0 ||
    !receiverBody.slice(receiverViewBindIndex).some((event) => event.kind === 'drawIndexed') ||
    resourceIdForBinding(viewGroup, 3) !== depthViewId
  ) {
    throw new Error('CSM receiver draw does not bind and draw from the cascade atlas view');
  }
  const receiverPipelineId = receiverBody.find((event) => event.kind === 'setPipeline')?.pipelineHandleId;
  const receiverPipeline = events.find(
    (event) => event.kind === 'createRenderPipeline' && event.handleId === receiverPipelineId,
  );
  const receiverShader = events.find(
    (event) =>
      event.kind === 'createShaderModule' &&
      event.handleId === receiverPipeline?.fragmentShaderModuleHandleId,
  );
  const cascadeShaderTerms = [
    '_pickCascadeLayer',
    '_atlasTileOrigin',
    '_sampleShadowForCascade',
    'cascadeBlend',
    'textureSampleCompareLevel',
  ];
  if (
    receiverShader?.wgslCode === undefined ||
    cascadeShaderTerms.some((term) => !receiverShader.wgslCode.includes(term))
  ) {
    throw new Error(`CSM receiver shader does not retain cascade selection/atlas sampling: ${receiverShader?.handleId}`);
  }
  assertCsmAtlasSamplerFormula(receiverShader.wgslCode);
  console.log(
    `[csm] receiver lineage selectors=${JSON.stringify(selectorValues)} ` +
      `atlas=${depthViewId} draws=${receiverBody.filter((event) => event.kind === 'drawIndexed').length}`,
  );
  const viewBufferId = resourceIdForBinding(viewGroup, 0);
  const viewBuffer = events.find(
    (event) => event.kind === 'createBuffer' && event.handleId === viewBufferId,
  );
  const viewBinding = viewGroup.entries?.find((entry) => entry.binding === 0);
  const viewBufferSize = viewBuffer?.desc?.size;
  if (
    viewBinding?.bufferSize !== 960 ||
    !Number.isInteger(viewBufferSize) ||
    viewBufferSize < 960 ||
    viewBufferSize % 1024 !== 0
  ) {
    throw new Error(
      `view/split UBO lineage is incomplete: ${JSON.stringify({
        buffer: viewBuffer?.desc,
        binding: viewBinding,
      })}`,
    );
  }
  const viewWrite = events.find(
    (event) => event.kind === 'writeBuffer' && event.handleId === viewBufferId && event.size === 960,
  );
  const viewBytes = viewWrite === undefined ? undefined : readBlob(viewWrite.dataHash);
  if (viewBytes === undefined || viewBytes.byteLength !== 960) {
    throw new Error('view/split UBO write blob is missing');
  }
  const viewFloats = new Float32Array(viewBytes.buffer, viewBytes.byteOffset, viewBytes.byteLength / 4);
  const cameraPosition = [viewFloats[24], viewFloats[25], viewFloats[26]];
  const expectedCameraPosition = [0, 1.5, 6];
  if (
    cameraPosition.some(
      (value, index) =>
        !Number.isFinite(value) || Math.abs(value - expectedCameraPosition[index]) > 0.01,
    )
  ) {
    throw new Error(`camera position lineage is not [0,1.5,6]: ${JSON.stringify(cameraPosition)}`);
  }
  const splits = [viewFloats[108], viewFloats[112], viewFloats[116], viewFloats[120]];
  const expectedSplits = expectedCsmSplits();
  if (splits.some((value, index) => !Number.isFinite(value) || Math.abs(value - expectedSplits[index]) > 0.02)) {
    throw new Error(`camera split values are not recorded in the view UBO: ${JSON.stringify(splits)}`);
  }
  if (splits.some((value, index) => index > 0 && value <= splits[index - 1])) {
    throw new Error(`camera split values are not strictly increasing: ${JSON.stringify(splits)}`);
  }
  const expectedShadowDistance = CSM_SCENE_SHADOW_DISTANCE[MVD_SCENE] ?? 50;
  if (Math.abs(splits.at(-1) - expectedShadowDistance) > 0.02) {
    throw new Error(
      `camera split far distance does not match active scene shadowDistance=${expectedShadowDistance}: ${JSON.stringify(splits)}`,
    );
  }
  const cascadeMatrixOffsets = [28, 60, 76, 92];
  const cascadeMatrices = cascadeMatrixOffsets.map((offset) => viewFloats.slice(offset, offset + 16));
  if (
    cascadeMatrices.some(
      (matrix) => matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value)) || matrix.every((value) => value === 0),
    )
  ) {
    throw new Error('one or more cascade lightViewProj matrices are missing from the View UBO');
  }
  const adjacentMatrixDelta = cascadeMatrices.slice(1).map((matrix, index) =>
    Math.max(...matrix.map((value, element) => Math.abs(value - cascadeMatrices[index][element]))),
  );
  if (adjacentMatrixDelta.some((delta) => delta < 0.0001)) {
    throw new Error(`cascade lightViewProj matrices are not depth-derived: ${JSON.stringify(adjacentMatrixDelta)}`);
  }
  const cascadeCount = viewFloats[124];
  const cascadeBlend = viewFloats[125];
  if (!Number.isFinite(cascadeCount) || Math.abs(cascadeCount - 4) > 0.01) {
    throw new Error(`expected cascadeCount=4 in the View UBO, got ${cascadeCount}`);
  }
  if (!Number.isFinite(cascadeBlend) || Math.abs(cascadeBlend - 0.2) > 0.01) {
    throw new Error(`expected cascadeBlend=0.2 in the View UBO, got ${cascadeBlend}`);
  }
  console.log(
    `[csm] View UBO lineage camera=${JSON.stringify(cameraPosition)} ` +
      `matrixDelta=${JSON.stringify(adjacentMatrixDelta)} count=${cascadeCount} blend=${cascadeBlend}`,
  );
  const filterCarrier = viewFloats.slice(128, 132);
  if (
    filterCarrier.some((value) => !Number.isFinite(value)) ||
    filterCarrier[0] !== 2 ||
    filterCarrier.slice(1).some((value) => value !== 0)
  ) {
    throw new Error(`directional PCF3 filter carrier is not recorded in the View UBO: ${JSON.stringify(filterCarrier)}`);
  }
  console.log(`[csm] directional filter carrier=${JSON.stringify(filterCarrier)} accepted`);
  if (viewFloats.slice(0, 16).every((value) => value === 0 || !Number.isFinite(value))) {
    throw new Error('camera matrix region in the view UBO is empty');
  }
}
