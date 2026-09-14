import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const renderSystemSource = readFileSync(
  resolve(import.meta.dirname, '../render-system.ts'),
  'utf8',
);
const recoveryCandidateSource = readFileSync(
  resolve(import.meta.dirname, '../recovery/render-system-candidate.ts'),
  'utf8',
);
const rendererSource = readFileSync(
  resolve(import.meta.dirname, '../assembly/webgpu-renderer.ts'),
  'utf8',
);
const rendererRecoverySource = readFileSync(
  resolve(import.meta.dirname, '../assembly/recovery/renderer-recover.ts'),
  'utf8',
);

describe('recovery candidate preparation contract', () => {
  it('keeps graph preparation outside draw, record, execute, and submit', () => {
    const start = recoveryCandidateSource.indexOf('const prepareRecoveryGraphCandidate');
    const end = recoveryCandidateSource.indexOf('const submitCandidateSetup', start);
    const prepare = recoveryCandidateSource.slice(start, end);

    expect(prepare).toContain('prepareFrameLighting');
    expect(prepare).toContain('ensureCompiledFrameGraph');
    expect(prepare).toContain("kind: 'no-seed'");
    expect(prepare).toContain("kind: 'failed'");
    expect(prepare).toContain("kind: 'ready'");
    expect(prepare).not.toMatch(
      /\.draw\(|recordFrame\(|executeCompiledFrameGraph|queue\.submit|\.finish\(/,
    );
  });

  it('keeps active generation bindings unchanged until publication', () => {
    const start = rendererRecoverySource.indexOf('const candidateInternals =');
    const end = rendererRecoverySource.indexOf('const preparedRecoveryRoots =', start);
    const candidate = rendererRecoverySource.slice(start, end);

    expect(candidate).toContain('prepareRecoveryGraphCandidate');
    expect(candidate).toContain("graphPreparation.kind === 'failed'");
    expect(candidate).toContain("graphPreparation.kind === 'ready'");
    expect(candidate).toContain('submitCandidateSetup');
    expect(candidate).not.toMatch(/internals\.device\s*=/);
    expect(candidate).not.toMatch(/internals\.generationState\.current\s*=/);
    expect(candidate).not.toContain('renderSystem.resetForRecover');
    expect(candidate).not.toContain('featureHost?.recover');
    expect(candidate).not.toContain('renderTargetHost.beginFrame');
    expect(rendererRecoverySource.indexOf('submitCandidateSetup', start)).toBeLessThan(
      rendererRecoverySource.indexOf('const preparedRecoveryRoots', start),
    );
    expect(rendererRecoverySource).toContain('recoveryRootBundle');
    expect(rendererSource).toContain('publishAndRetireRendererGeneration');
  });

  it('prepares roots from candidate state and switches environment owner only at publish', () => {
    const start = renderSystemSource.indexOf('prepareRecoveryRoots(runtime: RecoveryRootRuntime)');
    const end = renderSystemSource.indexOf('\n    },\n  };', start);
    const roots = renderSystemSource.slice(start, end);

    expect(roots).toContain('runtime.scope');
    expect(roots).toContain('createRecoveryCandidate');
    expect(roots).toContain('candidateEnvironmentGeneration');
    expect(roots).toContain('candidateEnvironmentLifecycle.publish');
    expect(roots).toContain('candidateEnvironmentLifecycle.discard');
    expect(roots).toContain('graphCandidate.featureHost.createRecoveryRoot');
    expect(roots).toContain('graphCandidate.featureGpuWork.createRecoveryRoot');
    expect(roots).toContain('graphCandidate.gpuDrivenProduction.createRecoveryRoot');
    expect(roots).toContain('graphCandidate.gpuDrivenScene.createRecoveryRoot');
    expect(roots).toContain('graphCandidate.pointsLines.createRecoveryRoot');
    expect(roots).toContain('runtime.gpuStore.createRecoveryRoot');
    expect(roots).toContain('return compiledGraph');
    expect(roots).not.toContain('environmentLifecycle.createRecoveryRoot');
    expect(roots).not.toContain('featureCount');
    expect(roots).not.toContain("owner: 'gpu-driven-production'");
    expect(rendererSource).toContain('recoveryRootBundle.publish()');
    expect(rendererRecoverySource).toContain('rootBundle.discard()');
    expect(roots).toContain('cleanup: releaseGraphCandidate');
  });

  it('submits only explicit mip setup work without creating frame evidence', () => {
    const start = recoveryCandidateSource.indexOf('const submitCandidateSetup');
    const end = recoveryCandidateSource.indexOf('\n  return {', start);
    const setup = recoveryCandidateSource.slice(start, end);

    expect(setup).toContain('work.finish()');
    expect(setup).toContain('candidate.device.queue.submit');
    expect(setup).toContain('candidate.device.queue.onSubmittedWorkDone');
    expect(setup.match(/candidate\.device\.queue\.submit/g)).toHaveLength(1);
    expect(setup).not.toContain('submittedFrameCount');
    expect(setup).not.toContain('directFrameId');
    expect(setup).not.toContain('frameState');
    expect(setup).not.toContain('recordFrame');
  });

  it('arms the first published frame only after candidate pipeline preparation', () => {
    expect(recoveryCandidateSource).toContain(
      'candidate.recoveryReadiness.assertFirstRecoveryFrame()',
    );
    expect(recoveryCandidateSource).toContain('pointsLinesOwner.prepareRecoveryCandidate');
    expect(renderSystemSource).toContain('pointsLinesOwner.abandonForDeviceLoss');
    expect(rendererSource).toContain(
      'candidate.producerBindings.gpuStore.setRecoveryColdWorkGuard',
    );
    expect(rendererSource).toContain('recoveryColdWorkGuard.arm()');
    expect(renderSystemSource).toContain('internals.recoveryColdWorkGuard?.notePipelineColdWork()');
    expect(recoveryCandidateSource).toContain('const previousFeatureHost = internals.featureHost');
    expect(recoveryCandidateSource).toContain('const disposed = previousFeatureHost.dispose()');
    expect(recoveryCandidateSource).toContain('previousFeatureHost !== candidate.featureHost');
  });

  it('keeps material pipelines scoped to the active recovery generation', () => {
    expect(rendererSource).toContain('currentPipelineCacheState().materialShaderPipelineCache');
    expect(rendererSource).not.toMatch(/\n\s*materialShaderPipelineCache\.(get|set|has)\(/);
  });

  it('resolves recovery variants from the candidate device capabilities', () => {
    const start = rendererSource.indexOf('const resolveCachedMaterialShaderVariantSet');
    const end = rendererSource.indexOf('const findMaterialShaderManifestEntry', start);
    const resolver = rendererSource.slice(start, end);

    expect(resolver).toContain('const device = currentBuildDevice()');
    expect(resolver).not.toContain('internals.device.caps');
    expect(resolver).not.toContain('internals.device.limits');
  });

  it('keeps render-system residency bindings live across publication', () => {
    const start = rendererSource.indexOf('const renderSystem: RenderSystem = createRenderSystem({');
    const end = rendererSource.indexOf('errorRegistry: internals.errorRegistry', start);
    const assembly = rendererSource.slice(start, end);

    expect(assembly).toContain('get gpuStore()');
    expect(assembly).toContain('get dynamicTextureStore()');
    expect(assembly).not.toMatch(/\n\s*gpuStore,\n/);
    expect(assembly).not.toMatch(/\n\s*dynamicTextureStore,\n/);
  });
});
