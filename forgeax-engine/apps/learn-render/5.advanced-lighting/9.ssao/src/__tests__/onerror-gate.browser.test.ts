import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

// The enclosing-room + backpack asset cold start can exceed one minute on a
// contended lavapipe browser runner. Keep the gate bounded while allowing the
// real WebGPU bootstrap to finish instead of turning normal startup into a
// timeout red.
onerrorGate('learn-render 5.9 ssao', () => import('../main.ts'), 90_000);
