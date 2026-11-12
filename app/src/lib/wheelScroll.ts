/**
 * Wheel scrolling for the code panes: one detent, one row.
 *
 * A diff is read line by line, and the rows are deliberately compact (20px by
 * default). A system wheel notch is 40-60px, so a single detent moved two to three
 * rows at once. That is fast enough that the *current change* marker — the accent
 * bar that answers "which hunk am I on" — slides past before the eye can land on
 * it, which is exactly what "the blue highlight flashes by" means.
 *
 * The rule here is one row per wheel event, eased over a few frames. It is
 * expressed in rows rather than as a fraction of the OS delta because the OS delta
 * is not portable: a notch is 40px on one platform, 53px on another, and a plain
 * line count in line mode. "One wheel event moves at most one row" needs none of
 * that knowledge, and it leaves fine trackpad deltas — usually smaller than a row
 * already — untouched, so pointing devices keep their own feel.
 *
 * Horizontal pans, pinch-zoom (ctrl/meta) and page-mode deltas are left to the
 * browser. This is a vertical reading aid, not a replacement for the scroller: the
 * pane still owns its offset, still fires `scroll`, and the parent still mirrors
 * both panes from that one authority.
 */

import type { Action } from "svelte/action";

/** Rows a single wheel event may travel. */
export const MAX_STEP_ROWS = 1;

/** Row height assumed when the CSS custom property is missing or unreadable. */
export const FALLBACK_ROW_PX = 20;

/** Share of the remaining distance consumed per animation frame. */
export const EASE_FACTOR = 0.4;

/** Distance at which the animator lands exactly on its target, in px. */
export const SNAP_PX = 0.5;

/** The event fields this module needs; `WheelEvent` satisfies it structurally. */
export interface WheelDeltaEvent {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  ctrlKey: boolean;
  metaKey: boolean;
}

/**
 * Row height in px, read from the `--row-height` custom property.
 *
 * The value is a CSS length (`"20px"`), so it needs parsing; a corrupt or absent
 * value falls back to the shipped default rather than to `NaN`, which would make
 * the step maths silently stop capping.
 */
export function rowHeightPx(raw: string | null | undefined): number {
  const px = raw === null || raw === undefined ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(px) && px > 0 ? px : FALLBACK_ROW_PX;
}

/** Clamp one wheel step to one row, keeping its direction. */
export function wheelStepPx(deltaY: number, rowPx: number): number {
  if (!Number.isFinite(deltaY) || deltaY === 0) return 0;
  const max = rowPx * MAX_STEP_ROWS;
  const magnitude = Math.min(Math.abs(deltaY), max);
  return deltaY < 0 ? -magnitude : magnitude;
}

/**
 * Pixels one wheel event should move the pane, or `null` to leave it to the
 * browser.
 *
 * `null` covers the events that are not vertical reading input: pinch-zoom
 * (`ctrlKey` on macOS), browser gestures (`metaKey`), page-mode deltas, and pans
 * that are mostly horizontal — the last one matters because the panes scroll
 * horizontally too, and swallowing those would break unaided two-finger pans.
 */
export function wheelDeltaPx(event: WheelDeltaEvent, rowPx: number): number | null {
  if (event.ctrlKey || event.metaKey) return null;
  if (event.deltaMode === 2) return null;
  if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return null;

  // Line mode reports lines rather than pixels; one line is one row here.
  const px = event.deltaMode === 1 ? event.deltaY * rowPx : event.deltaY;
  const step = wheelStepPx(px, rowPx);
  return step === 0 ? null : step;
}

/** Keep an offset inside the scrollable range; an unscrollable pane is 0. */
export function clampOffset(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(Math.max(value, 0), max);
}

/**
 * One frame of an exponential ease towards `target`.
 *
 * Exponential rather than a timed tween: wheel events arrive in bursts, and a
 * fixed-duration animation restarted per event stutters. Chasing the target a
 * fraction at a time absorbs bursts naturally and never overshoots, because the
 * step is always smaller than the remaining distance.
 */
export function easeToward(current: number, target: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= SNAP_PX) return target;
  return current + delta * EASE_FACTOR;
}

/**
 * Attach eased, row-capped wheel scrolling to a scroll container.
 *
 * The listener must be non-passive: `preventDefault` is what stops the browser
 * from applying the raw OS delta on top of ours. Anything that moves the pane
 * without us — a hunk jump, a tab restore, the parent mirroring the other pane —
 * cancels the animation instead of fighting it for the offset.
 */
export const slowWheel: Action<HTMLElement> = (node) => {
  let target = node.scrollTop;
  let frame = 0;
  // Last offset this action wrote. A `scroll` that disagrees is somebody else.
  let written = target;

  function rowPx(): number {
    // `--row-height` is set on the document root and inherits down to the pane.
    return rowHeightPx(getComputedStyle(node).getPropertyValue("--row-height"));
  }

  function step(): void {
    frame = 0;
    const current = node.scrollTop;
    const next = easeToward(current, target);
    if (next === current) return;
    written = next;
    node.scrollTop = next;
    frame = requestAnimationFrame(step);
  }

  function onWheel(event: WheelEvent): void {
    const max = Math.max(0, node.scrollHeight - node.clientHeight);
    if (max === 0) return;

    const delta = wheelDeltaPx(event, rowPx());
    if (delta === null) return;

    event.preventDefault();

    // While an animation is in flight the target, not the current offset, is the
    // base: otherwise a burst of notches would each restart from a position the
    // pane has not reached yet and the burst would collapse into a single step.
    const base = frame === 0 ? node.scrollTop : target;
    const next = clampOffset(base + delta, max);
    if (next === base && frame === 0) return;

    target = next;
    if (frame === 0) frame = requestAnimationFrame(step);
  }

  function onScroll(): void {
    if (frame === 0) return;
    if (Math.abs(node.scrollTop - written) > SNAP_PX * 3) {
      cancelAnimationFrame(frame);
      frame = 0;
      target = node.scrollTop;
    }
  }

  node.addEventListener("wheel", onWheel, { passive: false });
  node.addEventListener("scroll", onScroll, { passive: true });

  return {
    destroy() {
      if (frame !== 0) cancelAnimationFrame(frame);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("scroll", onScroll);
    },
  };
};
