// hello-cube RHI-debug browser smoke: shared structural capture verifier.

import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyDemoCapture } from '../../../shared/scripts/rhi-debug-verify.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

await verifyDemoCapture({
  pkg: '@forgeax/hello-cube',
  label: 'hello-cube',
  mode: 'structural',
  // Shadow/depth draws and post-process dispatches precede the first colour
  // attachment in the capture. Inspect that attachment-bearing draw so the
  // shared verifier requests a real render target rather than a depth-only
  // pass or compute dispatch.
  workIndex: 7,
  appDir: dirname(scriptsDir),
});
