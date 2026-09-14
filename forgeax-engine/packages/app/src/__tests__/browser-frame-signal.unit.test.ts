import { describe, expect, it } from 'vitest';

import {
  FORGEAX_FRAME_SUBMITTED_EVENT,
  publishBrowserFrameSubmitted,
} from '../browser-frame-signal';

describe('publishBrowserFrameSubmitted', () => {
  it('projects Dawn canvas progress without requiring DOM event methods', () => {
    const documentElement = { dataset: {} as DOMStringMap };
    const canvas = { ownerDocument: { documentElement } } as HTMLCanvasElement;

    expect(() =>
      publishBrowserFrameSubmitted(canvas, { frameId: 7, deviceGeneration: 2 }),
    ).not.toThrow();
    expect(documentElement.dataset.forgeaxFrameSubmitted).toBe('7');
  });

  it('dispatches the browser event when the canvas supports dispatchEvent', () => {
    let dispatchedEvent: Event | undefined;
    const dispatchEvent = (event: Event): boolean => {
      dispatchedEvent = event;
      return true;
    };
    const canvas = { dispatchEvent } as unknown as HTMLCanvasElement;

    publishBrowserFrameSubmitted(canvas, { frameId: 9, deviceGeneration: 3 });

    expect(dispatchedEvent).toBeInstanceOf(CustomEvent);
    if (!(dispatchedEvent instanceof CustomEvent))
      throw new Error('frame event was not dispatched');
    expect(dispatchedEvent.type).toBe(FORGEAX_FRAME_SUBMITTED_EVENT);
    expect(dispatchedEvent.detail).toEqual({ frameId: 9, deviceGeneration: 3 });
  });
});
