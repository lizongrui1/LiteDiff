/**
 * Auto-hide state machine for an overlay control.
 *
 * Used by the minimap: it is an overlay, so it must appear while the user is
 * scrolling and fade once the viewport has been still. The timing logic is the
 * part that can be wrong (a stuck timer, a hover that never releases, a drag that
 * hides mid-gesture), so it lives here where `node --test` can drive it with a
 * fake clock instead of only being reachable through a running window.
 *
 * Plain object, no Svelte: the component owns `$state` and this decides *when*.
 */

/** How long the strip stays visible after the last activity, in ms. */
export const HIDE_DELAY_MS = 1100;

export interface AutoHideOptions {
  /** Idle delay before hiding; defaults to {@link HIDE_DELAY_MS}. */
  delay?: number;
  /** Injected so tests need no real clock. */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
  /** Called whenever visibility changes, so the host can re-render. */
  onChange?: (visible: boolean) => void;
}

/**
 * Visibility = "was recently active" OR "the pointer is over it" OR "dragging".
 *
 * The three are kept separate rather than collapsed into one boolean because they
 * have different lifetimes: activity expires on a timer, hover ends on an event,
 * and a drag outranks both — a drag must never be interrupted by its own timer.
 */
export class AutoHide {
  private active = false;
  private hovering = false;
  private dragging = false;
  private timer: unknown = null;
  private readonly delay: number;
  private readonly schedule: (fn: () => void, ms: number) => unknown;
  private readonly cancel: (handle: unknown) => void;
  private readonly onChange: (visible: boolean) => void;
  private lastVisible: boolean;

  constructor(opts: AutoHideOptions = {}) {
    this.delay = opts.delay ?? HIDE_DELAY_MS;
    this.schedule = opts.schedule ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = opts.cancel ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.onChange = opts.onChange ?? (() => {});
    this.lastVisible = this.compute();
  }

  private compute(): boolean {
    return this.dragging || this.hovering || this.active;
  }

  /** Current visibility. */
  get visible(): boolean {
    return this.compute();
  }

  private emit(): void {
    const now = this.compute();
    if (now === this.lastVisible) return;
    this.lastVisible = now;
    this.onChange(now);
  }

  /**
   * Record activity: show now, hide after `delay` of silence.
   *
   * Every call restarts the timer, so a continuous scroll never schedules a hide
   * that a later event has to undo — the last scroll in a burst decides.
   */
  wake(): void {
    this.active = true;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.timer = this.schedule(() => {
      this.timer = null;
      this.active = false;
      this.emit();
    }, this.delay);
    this.emit();
  }

  /**
   * Pointer entered or left the control.
   *
   * Hovering cancels the pending hide outright rather than pausing it: leaving the
   * control should start a *fresh* delay, otherwise the countdown continues in the
   * background and the strip vanishes the instant the pointer moves away.
   */
  hover(inside: boolean): void {
    this.hovering = inside;
    if (inside && this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    if (!inside && this.timer === null) {
      this.timer = this.schedule(() => {
        this.timer = null;
        this.active = false;
        this.emit();
      }, this.delay);
    }
    this.emit();
  }

  /** Start dragging: pinned visible, timer cancelled. */
  startDrag(): void {
    this.dragging = true;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
    this.emit();
  }

  /** End dragging: behaves like activity, so the strip fades after the gesture. */
  endDrag(): void {
    this.dragging = false;
    this.wake();
  }

  /** Drop the pending timer without changing state; for component teardown. */
  dispose(): void {
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }
}
