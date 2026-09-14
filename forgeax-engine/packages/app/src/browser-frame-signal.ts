/**
 * Browser-visible render progress owned by the App frame loop.
 *
 * The Renderer already emits `frame-submitted` after its sole queue-submit
 * boundary. This adapter projects that event onto the document without
 * exposing a renderer handle or creating a second readiness registry. DevKit
 * capture waits on the same projection, then verifies compositor pixels.
 */

export const FORGEAX_FRAME_SUBMITTED_DATASET = 'forgeaxFrameSubmitted';
export const FORGEAX_FRAME_SUBMITTED_EVENT = 'forgeax:frame-submitted';

export interface BrowserFrameSubmitted {
  readonly frameId: number;
  readonly deviceGeneration: number;
}

export function resetBrowserFrameSubmitted(canvas: HTMLCanvasElement): void {
  const documentElement = canvas.ownerDocument?.documentElement;
  if (documentElement !== undefined) {
    delete documentElement.dataset[FORGEAX_FRAME_SUBMITTED_DATASET];
  }
}

export function publishBrowserFrameSubmitted(
  canvas: HTMLCanvasElement,
  event: BrowserFrameSubmitted,
): void {
  const documentElement = canvas.ownerDocument?.documentElement;
  if (documentElement !== undefined) {
    documentElement.dataset[FORGEAX_FRAME_SUBMITTED_DATASET] = String(event.frameId);
  }
  // Dawn-node smoke canvases intentionally expose only the drawing-buffer
  // surface; they are not DOM EventTargets. Keep the document projection
  // above useful for those hosts, while dispatching the browser event only
  // when the host actually provides the optional EventTarget capability.
  if (typeof CustomEvent === 'function' && typeof canvas.dispatchEvent === 'function') {
    canvas.dispatchEvent(
      new CustomEvent(FORGEAX_FRAME_SUBMITTED_EVENT, {
        detail: Object.freeze({ ...event }),
      }),
    );
  }
}
