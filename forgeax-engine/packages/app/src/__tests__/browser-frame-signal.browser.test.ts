import { describe, expect, it } from 'vitest';

import {
  FORGEAX_FRAME_SUBMITTED_EVENT,
  publishBrowserFrameSubmitted,
} from '../browser-frame-signal';

describe('publishBrowserFrameSubmitted in a browser', () => {
  it('dispatches frame-submitted on a real HTMLCanvasElement', () => {
    const canvas = document.createElement('canvas');
    const received: Event[] = [];
    canvas.addEventListener(FORGEAX_FRAME_SUBMITTED_EVENT, (event) => received.push(event));

    publishBrowserFrameSubmitted(canvas, { frameId: 11, deviceGeneration: 4 });

    expect(received).toHaveLength(1);
    expect(received[0]).toBeInstanceOf(CustomEvent);
    expect((received[0] as CustomEvent).detail).toEqual({ frameId: 11, deviceGeneration: 4 });
  });
});
