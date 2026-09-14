import { onerrorGate } from '@forgeax/apps-shared/onerror-gate';

onerrorGate('learn-render 6.4 render-target-reflection', () => import('../index.ts'));
