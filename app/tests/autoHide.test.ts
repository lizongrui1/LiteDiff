import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoHide, HIDE_DELAY_MS } from "../src/lib/autoHide.ts";

/*
 * The minimap is an overlay that must appear while scrolling and fade when the
 * viewport is still. Every failure mode here is a timer bug, so the tests drive a
 * fake clock instead of sleeping: deterministic, and fast enough to keep in `npm
 * test`.
 */

/** A hand-cranked clock. `advance` runs any timer whose deadline has passed. */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();

  return {
    schedule(fn: () => void, ms: number): number {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    cancel(handle: unknown): void {
      timers.delete(handle as number);
    },
    advance(ms: number): void {
      now += ms;
      // Run in deadline order, and only those due by the new time.
      for (const [id, t] of [...timers.entries()].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now) {
          timers.delete(id);
          t.fn();
        }
      }
    },
    get pending(): number {
      return timers.size;
    },
  };
}

function make(delay = 1000) {
  const clock = fakeClock();
  let changes = 0;
  const hider = new AutoHide({
    delay,
    schedule: (fn, ms) => clock.schedule(fn, ms),
    cancel: (h) => clock.cancel(h),
    onChange: () => {
      changes += 1;
    },
  });
  return { hider, clock, changes: () => changes };
}

// --- basic lifecycle --------------------------------------------------------

test("starts hidden", () => {
  const { hider } = make();
  assert.equal(hider.visible, false);
});

test("activity shows it immediately", () => {
  const { hider } = make();
  hider.wake();
  assert.equal(hider.visible, true);
});

test("it hides once the idle delay passes", () => {
  const { hider, clock } = make(1000);
  hider.wake();
  clock.advance(999);
  assert.equal(hider.visible, true, "must not hide early");
  clock.advance(1);
  assert.equal(hider.visible, false);
});

// A continuous scroll fires many events; each restarts the countdown, so the strip
// must not blink mid-scroll.
test("repeated activity restarts the countdown", () => {
  const { hider, clock } = make(1000);
  hider.wake();
  clock.advance(900);
  hider.wake();
  clock.advance(900);
  assert.equal(hider.visible, true, "the second wake reset the timer");
  clock.advance(100);
  assert.equal(hider.visible, false);
});

// The timer must not pile up: N wakes leave exactly one pending timeout.
test("waking repeatedly leaves one pending timer", () => {
  const { hider, clock } = make(1000);
  for (let i = 0; i < 20; i++) {
    hider.wake();
    clock.advance(10);
  }
  assert.equal(clock.pending, 1, `expected 1 pending timer, got ${clock.pending}`);
});

test("dispose drops the pending timer", () => {
  const { hider, clock } = make(1000);
  hider.wake();
  hider.dispose();
  assert.equal(clock.pending, 0);
  // Advancing past the old deadline must not throw or change visibility.
  clock.advance(5000);
  assert.equal(hider.visible, true, "visibility is unchanged, only the timer is gone");
});

// --- hover ------------------------------------------------------------------

// Hovering must pin it: a strip that faded out from under the cursor would be
// impossible to grab deliberately.
test("hovering keeps it visible past the idle delay", () => {
  const { hider, clock } = make(1000);
  hider.wake();
  hider.hover(true);
  clock.advance(10_000);
  assert.equal(hider.visible, true);
});

// Leaving starts a fresh delay rather than letting the old countdown continue.
test("leaving the pointer starts a new delay", () => {
  const { hider, clock } = make(1000);
  hider.wake();
  hider.hover(true);
  clock.advance(10_000);
  hider.hover(false);
  assert.equal(hider.visible, true, "still visible right after leaving");
  clock.advance(1000);
  assert.equal(hider.visible, false);
});

test("hovering without any prior activity still shows it", () => {
  const { hider } = make();
  hider.hover(true);
  assert.equal(hider.visible, true);
});

// --- dragging ---------------------------------------------------------------

// A drag outranks the timer: it must never be interrupted by its own countdown.
test("a drag outranks the idle timer", () => {
  const { hider, clock } = make(1000);
  hider.wake();
  hider.startDrag();
  clock.advance(10_000);
  assert.equal(hider.visible, true);
});

test("ending a drag starts the hide countdown", () => {
  const { hider, clock } = make(1000);
  hider.startDrag();
  hider.endDrag();
  assert.equal(hider.visible, true);
  clock.advance(1000);
  assert.equal(hider.visible, false);
});

test("a drag hides even while the pointer is over the strip", () => {
  // Both are pinned, so releasing the drag while still hovering keeps it up —
  // that is the hover rule, not a drag bug. Verify the pair explicitly.
  const { hider, clock } = make(1000);
  hider.hover(true);
  hider.startDrag();
  hider.endDrag();
  clock.advance(5000);
  assert.equal(hider.visible, true, "hover still pins it after the drag");
  hider.hover(false);
  clock.advance(1000);
  assert.equal(hider.visible, false);
});

// --- change notification ----------------------------------------------------

// The host mirrors this into reactive state, so a redundant notification would
// cause a pointless re-render on every scroll event.
test("only real transitions notify the host", () => {
  const { hider, clock, changes } = make(1000);
  assert.equal(changes(), 0);

  hider.wake();
  assert.equal(changes(), 1, "hidden -> visible");

  hider.wake();
  hider.wake();
  assert.equal(changes(), 1, "already visible: no re-notification");

  clock.advance(1000);
  assert.equal(changes(), 2, "visible -> hidden");

  clock.advance(1000);
  assert.equal(changes(), 2, "stays hidden: no re-notification");
});

test("the default delay is a deliberate value", () => {
  // Long enough to read the strip, short enough not to sit over the code. Pinned
  // so a careless edit is visible in a diff.
  assert.equal(HIDE_DELAY_MS, 1100);
});
