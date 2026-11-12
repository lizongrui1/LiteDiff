/**
 * Wheel scrolling: one detent, one row.
 *
 * The panes are read line by line and the rows are 20px, but an OS wheel notch is
 * 40-60px, so a single detent used to jump two or three rows — fast enough that
 * the current-change marker was gone before the eye reached it. These tests pin
 * the rule that replaced it: a wheel event never travels more than one row, fine
 * trackpad deltas pass through untouched, and none of the non-vertical gestures
 * (pinch-zoom, page mode, horizontal pans) are swallowed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  EASE_FACTOR,
  MAX_STEP_ROWS,
  SNAP_PX,
  clampOffset,
  easeToward,
  rowHeightPx,
  slowWheel,
  wheelDeltaPx,
  wheelStepPx,
} from "../src/lib/wheelScroll.ts";

const ROW = 20;

const wheelEvent = (overrides: Partial<Parameters<typeof wheelDeltaPx>[0]> = {}) => ({
  deltaX: 0,
  deltaY: 0,
  deltaMode: 0,
  ctrlKey: false,
  metaKey: false,
  ...overrides,
});

// --- one detent, one row ----------------------------------------------------

test("a 40px notch moves one row, not two", () => {
  assert.equal(wheelStepPx(40, ROW), 20);
  assert.equal(wheelStepPx(-40, ROW), -20);
});

test("a notch wider than a row is capped, whatever the platform reports", () => {
  // The same physical notch is 40px on one platform and 53px on another; the step
  // must not depend on which number the OS picked.
  for (const delta of [40, 53, 120, 300]) {
    assert.equal(Math.abs(wheelStepPx(delta, ROW)), ROW * MAX_STEP_ROWS);
    assert.equal(Math.abs(wheelStepPx(-delta, ROW)), ROW * MAX_STEP_ROWS);
  }
});

test("trackpad-sized deltas pass through untouched", () => {
  // These are already smaller than a row: capping them changes nothing, which is
  // what keeps a trackpad's own feel intact.
  for (const delta of [0.5, 4, 11.75, 19.9]) {
    assert.equal(wheelStepPx(delta, ROW), delta);
    assert.equal(wheelStepPx(-delta, ROW), -delta);
  }
});

test("the cap follows the row height, not a fixed pixel budget", () => {
  assert.equal(wheelStepPx(40, 30), 30);
  assert.equal(wheelStepPx(40, 12), 12);
});

test("a zero or non-finite delta never scrolls", () => {
  assert.equal(wheelStepPx(0, ROW), 0);
  assert.equal(wheelStepPx(Number.NaN, ROW), 0);
  assert.equal(wheelStepPx(Number.POSITIVE_INFINITY, ROW), 0);
});

// --- row height -------------------------------------------------------------

test("row height is parsed from the CSS custom property", () => {
  assert.equal(rowHeightPx("20px"), 20);
  assert.equal(rowHeightPx("17.5px"), 17.5);
  assert.equal(rowHeightPx("20"), 20);
});

test("a missing or corrupt row height falls back instead of yielding NaN", () => {
  for (const raw of [null, undefined, "", "auto", "0px", "-4px", "NaNpx"]) {
    assert.equal(rowHeightPx(raw), 20);
  }
});

// --- gestures that are not ours --------------------------------------------

test("pinch-zoom and browser gestures are left to the browser", () => {
  // macOS reports a trackpad pinch as a wheel event with ctrlKey set. Taking it
  // over would break zoom; the panes must not see it at all.
  assert.equal(wheelDeltaPx(wheelEvent({ deltaY: 40, ctrlKey: true }), ROW), null);
  assert.equal(wheelDeltaPx(wheelEvent({ deltaY: 40, metaKey: true }), ROW), null);
});

test("page-mode deltas are left to the browser", () => {
  assert.equal(wheelDeltaPx(wheelEvent({ deltaY: 1, deltaMode: 2 }), ROW), null);
});

test("a mostly horizontal pan stays native", () => {
  // The panes scroll horizontally too; swallowing a two-finger pan would break
  // reading long lines.
  assert.equal(wheelDeltaPx(wheelEvent({ deltaX: 40, deltaY: 2 }), ROW), null);
  assert.equal(wheelDeltaPx(wheelEvent({ deltaX: -40, deltaY: 0 }), ROW), null);
});

test("a vertical wheel with a little sideways noise is still ours", () => {
  assert.equal(wheelDeltaPx(wheelEvent({ deltaX: 2, deltaY: 40 }), ROW), ROW);
});

test("line-mode deltas are converted through the row height before capping", () => {
  // Firefox reports lines, not pixels: three lines is already more than one row.
  assert.equal(wheelDeltaPx(wheelEvent({ deltaY: 3, deltaMode: 1 }), ROW), ROW);
  assert.equal(wheelDeltaPx(wheelEvent({ deltaY: -3, deltaMode: 1 }), ROW), -ROW);
});

test("a zero delta is not a scroll", () => {
  assert.equal(wheelDeltaPx(wheelEvent({ deltaY: 0 }), ROW), null);
});

// --- bounds and easing ------------------------------------------------------

test("offsets are clamped to the scrollable range", () => {
  assert.equal(clampOffset(-10, 500), 0);
  assert.equal(clampOffset(120, 500), 120);
  assert.equal(clampOffset(900, 500), 500);
  assert.equal(clampOffset(120, 0), 0, "an unscrollable pane sits at zero");
  assert.equal(clampOffset(Number.NaN, 500), 0);
});

test("the ease always moves towards the target and never past it", () => {
  let value = 0;
  let previous = value;
  for (let frame = 0; frame < 60; frame++) {
    value = easeToward(value, 100);
    assert.ok(value >= previous, "the ease must not reverse");
    assert.ok(value <= 100, `the ease overshot to ${value}`);
    previous = value;
  }
  assert.equal(value, 100, "the ease must land exactly on the target");
});

test("the ease settles in a handful of frames, not a visible second", () => {
  let value = 0;
  let frames = 0;
  while (value !== 100 && frames < 120) {
    value = easeToward(value, 100);
    frames++;
  }
  // 0.4 per frame: 90% after about five frames, flat after about ten.
  assert.ok(frames <= 12, `took ${frames} frames to settle`);
  assert.ok(EASE_FACTOR > 0 && EASE_FACTOR < 1);
});

test("a distance under the snap threshold lands immediately", () => {
  assert.equal(easeToward(10, 10 + SNAP_PX), 10 + SNAP_PX);
  assert.equal(easeToward(10, 10.4), 10.4);
  assert.equal(easeToward(10.4, 10), 10);
});

// --- wiring -----------------------------------------------------------------

const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(`../src/lib/${name}`, import.meta.url)), "utf8");

test("both scrolling views use the eased wheel action", () => {
  for (const name of ["DiffPane.svelte", "UnifiedView.svelte"]) {
    const source = read(name);
    assert.match(source, /import \{ slowWheel \} from "\.\/wheelScroll";/, `${name} import`);
    assert.match(source, /use:slowWheel/, `${name} must attach the action to its scroller`);
  }
});

test("the wheel listener stays non-passive, or preventDefault is a no-op", () => {
  // A passive listener cannot cancel the native scroll, so the pane would apply
  // the eased step *and* the raw OS delta — double speed, the opposite of the fix.
  const source = read("wheelScroll.ts");
  assert.match(source, /addEventListener\("wheel", onWheel, \{ passive: false \}\)/);
  assert.doesNotMatch(source, /addEventListener\("wheel", onWheel, \{ passive: true \}\)/);
});

// --- the action, driven one frame at a time ---------------------------------
//
// The pure functions above decide *how far* one event travels; this harness pins
// the part that only exists at runtime: that the browser's default scroll is
// cancelled, that a burst of notches accumulates instead of collapsing, and that
// somebody else moving the pane (a jump, a tab restore, the sibling pane) stops the
// animation instead of leaving a stale target behind.

interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
  preventDefault(): void;
}

interface Harness {
  node: {
    scrollTop: number;
    clientHeight: number;
    scrollHeight: number;
    addEventListener(type: string, fn: (event: WheelLike) => void, options?: unknown): void;
    removeEventListener(type: string, fn: (event: WheelLike) => void): void;
  };
  dispatch(deltaY: number, extra?: Partial<WheelLike>): boolean;
  fire(type: "scroll" | "wheel", event: WheelLike): void;
  /** Run queued animation frames until the queue drains. */
  settle(maxFrames?: number): number;
  pending(): number;
  destroy(): void;
}

function harness(scrollHeight = 4000, clientHeight = 200): Harness {
  const listeners: Record<string, (event: WheelLike) => void> = {};
  const frames = new Map<number, () => void>();
  let nextId = 0;

  const node = {
    scrollTop: 0,
    clientHeight,
    scrollHeight,
    addEventListener(type: string, fn: (event: WheelLike) => void) {
      listeners[type] = fn;
    },
    removeEventListener(type: string, fn: (event: WheelLike) => void) {
      if (listeners[type] === fn) delete listeners[type];
    },
  };

  const previous = {
    raf: globalThis.requestAnimationFrame,
    caf: globalThis.cancelAnimationFrame,
    gcs: globalThis.getComputedStyle,
  };
  globalThis.requestAnimationFrame = ((cb: () => void) => {
    nextId += 1;
    frames.set(nextId, cb);
    return nextId;
  }) as unknown as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((id: number) => {
    frames.delete(id);
  }) as unknown as typeof cancelAnimationFrame;
  globalThis.getComputedStyle = (() =>
    ({ getPropertyValue: () => "20px" }) as unknown as CSSStyleDeclaration) as unknown as typeof getComputedStyle;

  const action = slowWheel(node as unknown as HTMLElement);

  const restore = () => {
    globalThis.requestAnimationFrame = previous.raf;
    globalThis.cancelAnimationFrame = previous.caf;
    if (previous.gcs === undefined) {
      delete (globalThis as { getComputedStyle?: unknown }).getComputedStyle;
    } else {
      globalThis.getComputedStyle = previous.gcs;
    }
  };

  return {
    node,
    dispatch(deltaY, extra = {}) {
      let prevented = false;
      listeners.wheel?.({
        deltaX: 0,
        deltaY,
        deltaMode: 0,
        ctrlKey: false,
        metaKey: false,
        preventDefault: () => {
          prevented = true;
        },
        ...extra,
      } as WheelLike);
      return prevented;
    },
    fire(type, event) {
      listeners[type]?.(event);
    },
    settle(maxFrames = 40) {
      let used = 0;
      while (frames.size > 0 && used < maxFrames) {
        const batch = [...frames.values()];
        frames.clear();
        for (const cb of batch) cb();
        used += 1;
      }
      return used;
    },
    pending: () => frames.size,
    destroy() {
      action?.destroy?.();
      restore();
    },
  };
}

test("one notch is cancelled, eased, and lands exactly one row down", () => {
  const h = harness();
  try {
    assert.equal(h.dispatch(40), true, "the raw OS scroll must be cancelled");
    h.settle();
    assert.equal(h.node.scrollTop, 20);
  } finally {
    h.destroy();
  }
});

test("a burst of notches accumulates instead of collapsing into one step", () => {
  const h = harness();
  try {
    h.dispatch(40);
    h.dispatch(40);
    h.dispatch(40);
    h.settle();
    assert.equal(h.node.scrollTop, 60, "three notches must travel three rows");
  } finally {
    h.destroy();
  }
});

test("a trackpad-sized delta is applied as-is", () => {
  const h = harness();
  try {
    h.dispatch(4);
    h.settle();
    assert.equal(h.node.scrollTop, 4);
  } finally {
    h.destroy();
  }
});

test("the pane stops at its own bounds", () => {
  const h = harness(220, 200); // only 20px of range
  try {
    for (let i = 0; i < 5; i++) h.dispatch(40);
    h.settle();
    assert.equal(h.node.scrollTop, 20);
    h.dispatch(-40);
    h.settle();
    assert.equal(h.node.scrollTop, 0, "scrolling up from the top stays at the top");
  } finally {
    h.destroy();
  }
});

test("an external move cancels the animation instead of being dragged back", () => {
  const h = harness();
  try {
    h.dispatch(40);
    h.settle(1);
    assert.ok(h.node.scrollTop > 0, "the first frame moved the pane");

    // A hunk jump, a tab restore or the sibling pane writing the shared offset.
    h.node.scrollTop = 900;
    h.fire("scroll", { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault() {} });
    assert.equal(h.pending(), 0, "the animation must be abandoned");

    h.settle();
    assert.equal(h.node.scrollTop, 900, "the external position wins");
  } finally {
    h.destroy();
  }
});

test("gestures that are not ours are never prevented", () => {
  const h = harness();
  try {
    assert.equal(h.dispatch(40, { ctrlKey: true }), false, "pinch-zoom stays native");
    assert.equal(h.dispatch(40, { deltaX: 80 }), false, "horizontal pan stays native");
    assert.equal(h.node.scrollTop, 0);
  } finally {
    h.destroy();
  }
});

test("destroying the pane removes both listeners and any pending frame", () => {
  const h = harness();
  h.dispatch(40);
  h.destroy();
  assert.equal(h.pending(), 0, "a pending frame must not outlive the component");
  // After destroy the handlers are gone: dispatching cannot move the pane.
  h.fire("wheel", { deltaX: 0, deltaY: 40, deltaMode: 0, ctrlKey: false, metaKey: false, preventDefault() {} });
  assert.equal(h.node.scrollTop, 0);
});
