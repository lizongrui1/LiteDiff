<script lang="ts">
  /**
   * Minimap / global heat strip.
   *
   * Painted on a canvas rather than with DOM nodes: a 20k-line file would need
   * thousands of divs, but a single canvas repaint is one draw call and stays
   * smooth while the viewport moves.
   *
   * ## One coordinate space, shared with the scrollbar
   *
   * The strip is drawn in **display-item space** — the same list the virtual
   * scroller indexes — not in source-row space.
   *
   * That distinction is the whole point. Folding collapses a long unchanged run
   * into a single bar, so N source rows map to far fewer display items: with two
   * changes separated by a 600-line gap, 660 rows become 22 items. A map drawn in
   * source space puts the second change near the bottom while the native
   * scrollbar, which moves in display space, is still near the top. The two then
   * disagree by hundreds of pixels exactly when the document is large — which is
   * when the map is supposed to help.
   *
   * The viewport indicator goes one step further and is computed with the
   * scrollbar's own formula (`offset / (total - viewport)`), so the band and the
   * native thumb are the same rectangle at every scroll position.
   */

  import type { DisplayItem } from "../lib/viewport";
  import { minimapScale } from "../lib/viewport";
  import { KIND_EQUAL, KIND_INSERT } from "../lib/diffView";
  import { AutoHide } from "../lib/autoHide";
  import { metrics } from "../lib/theme";
  import { t } from "../lib/i18nStore";

  interface Props {
    /**
     * Per-row kinds, indexed by source row.
     *
     * The map reads each row's own `kind` instead of inferring change-ness from
     * hunks. Hunks describe *ranges*, and a range that is merely "not equal" does
     * not mean every row inside it changed — inferring from ranges painted whole
     * documents red. `kind` is per row and cannot lie.
     */
    rowKinds: Uint8Array;
    /** The flattened display list, in the order the panes render it. */
    items: DisplayItem[];
    /** Index into `items` of the first visible item. */
    viewStart: number;
    /** Row height in px, so item space can be converted to scroll offsets. */
    rowHeight: number;
    /**
     * Exact height of the scroll port, in px.
     *
     * Passed rather than derived from the item span: `ceil(clientHeight /
     * rowHeight)` items is how many rows intersect the port, not its height, and
     * the difference (784px vs 771px here) made the indicator ~6px taller than the
     * scrollbar thumb it mirrors.
     */
    clientHeight: number;
    /**
     * True scroll offset of the pane, in px.
     *
     * The indicator cannot derive this from `viewStart * rowHeight`: with folds in
     * the list, `firstVisible` also counts fold bars, so the product overshoots by
     * a few rows' worth of pixels (-7px measured mid-document).
     */
    scrollTop: number;
    /** Jump to a display-item index; the caller converts to a scroll offset. */
    onJump: (displayIndex: number) => void;
  }

  let { rowKinds, items, viewStart, rowHeight, clientHeight, scrollTop, onJump }: Props =
    $props();
  let canvas = $state<HTMLCanvasElement | null>(null);
  let height = $state(0);
  let track = $state<HTMLDivElement | null>(null);
  let dragging = $state(false);

  /*
   * Auto-hide.
   *
   * The strip is an overlay now, so it costs no layout width — but it still sits
   * on top of the code, and a permanently-visible band over the last few columns
   * of every line is worse than a narrow gutter. So it behaves like a native
   * overlay scrollbar: appears while the user is scrolling or dragging, and fades
   * out once the viewport has been still for a moment.
   *
   * `revealed` is driven by activity; `pointerInside` keeps it up while the user
   * is aiming at it, because fading out from under the cursor would make it
   * impossible to grab deliberately.
   */
  let revealed = $state(false);
  let pointerInside = $state(false);

  /*
   * The timing rules live in `autoHide.ts`, which is unit-tested with a fake clock;
   * this only mirrors the result into reactive state so the template can fade.
   */
  const hider = new AutoHide({
    onChange: (v) => {
      revealed = v;
    },
  });


  /** Show the strip and restart the idle timer. */
  function wake(): void {
    hider.wake();
  }

  /**
   * Reveal on any scroll.
   *
   * Gated on `scrollTop` rather than on a prop the parent would have to add: the
   * strip already receives the scroll offset, and it is the exact signal that
   * matters. Programmatic jumps (⌘], minimap clicks) also change it, so they reveal
   * the strip too — which is correct, since they move the same viewport.
   *
   * The first run is skipped: an effect fires once on mount, and revealing then
   * would show the strip on a freshly-opened comparison nobody has scrolled yet,
   * then hide it a second later. Only a real change counts as activity.
   *
   * Capturing `scrollTop` by value is deliberate — it is the baseline this effect
   * compares against, not a value to re-read on every run.
   */
  // svelte-ignore state_referenced_locally
  let lastSeen = scrollTop;
  $effect(() => {
    const now = scrollTop;
    if (now === lastSeen) return;
    lastSeen = now;
    wake();
  });

  /** Drop the pending timer on teardown so it cannot fire against a dead component. */
  $effect(() => () => hider.dispose());

  const total = $derived(items.length);

  /**
   * True when the document can actually scroll.
   *
   * A file that fits the pane has no scroll position to indicate, and showing a
   * strip that cannot move would suggest content is hidden below. The user's
   * complaint about a reserved-but-empty axis applies most sharply here.
   */
  const scrollable = $derived(total * rowHeight > clientHeight + 1);

  const visible = $derived(scrollable && (revealed || pointerInside || dragging));
  /** Display-item index under a client-space Y coordinate. */
  function indexAt(clientY: number): number {
    if (!track || total === 0) return 0;
    const rect = track.getBoundingClientRect();
    if (rect.height === 0) return 0;
    const ratio = (clientY - rect.top) / rect.height;
    return Math.max(0, Math.min(total - 1, Math.floor(ratio * total)));
  }

  function onPointerDown(event: PointerEvent): void {
    // Capture so the drag keeps working when the pointer leaves the strip.
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging = true;
    hider.startDrag();
    onJump(indexAt(event.clientY));
  }

  function onPointerMove(event: PointerEvent): void {
    if (!dragging) return;
    onJump(indexAt(event.clientY));
  }

  function onPointerUp(event: PointerEvent): void {
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    // Behaves like activity, so the strip fades after the gesture rather than
    // staying up until the next unrelated scroll.
    hider.endDrag();
  }

  /** Keyboard stepping: PageUp/PageDown semantics over the whole document. */
  function onKeyDown(event: KeyboardEvent): void {
    const step = Math.max(1, Math.floor(total / 20));
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        onJump(Math.min(total - 1, viewStart + step));
        break;
      case "ArrowUp":
        event.preventDefault();
        onJump(Math.max(0, viewStart - step));
        break;
      case "PageDown":
        event.preventDefault();
        onJump(Math.min(total - 1, viewStart + step * 4));
        break;
      case "PageUp":
        event.preventDefault();
        onJump(Math.max(0, viewStart - step * 4));
        break;
      case "Home":
        event.preventDefault();
        onJump(0);
        break;
      case "End":
        event.preventDefault();
        onJump(Math.max(0, total - 1));
        break;
    }
  }


  // --- layer caching -----------------------------------------------------

  /**
   * Offscreen copy of everything that does NOT depend on scroll position: the
   * background, the change ticks, and the fold bands.
   *
   * Scrolling changes only the viewport indicator, but the old code repainted the
   * whole strip — including an O(rows) classification pass and a `palette()` call
   * (which forces a style recalculation) for every run — on every scroll event.
   * In a 20k-line document that is tens of thousands of operations per wheel tick,
   * which is what made scrolling feel sticky.
   *
   * Splitting the layers makes a scroll a `drawImage` plus one `fillRect`.
   */
  let staticLayer: HTMLCanvasElement | null = null;
  /** Key describing what `staticLayer` was drawn from; a mismatch forces a redraw. */
  let staticKey = "";

  /** Pending animation frame for a repaint, so bursts of scroll events coalesce. */
  let frame = 0;



  function palette(name: string): string {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }



  /**
   * Rebuild the offscreen static layer.
   *
   * Called only when the document, the fold state, the size, or the theme changes —
   * not on scroll.
   */
  function buildStaticLayer(
    w: number,
    mapHeight: number,
    dpr: number,
    list: DisplayItem[],
    rowH: number,
    clientHeight: number,
  ): HTMLCanvasElement {
    const off = document.createElement("canvas");
    off.width = Math.round(w * dpr);
    off.height = Math.round(mapHeight * dpr);
    const c = off.getContext("2d");
    if (!c) return off;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    c.fillStyle = palette("--c-minimap-bg");
    c.fillRect(0, 0, w, mapHeight);

    const count = list.length;
    if (count === 0) return off;

    const { unit } = minimapScale(count, mapHeight, rowH, clientHeight);

    // One pass: classify each display item from its own row kind.
    const isChange = new Uint8Array(count);
    const isInsert = new Uint8Array(count);
    const isFold = new Uint8Array(count);
    for (let i = 0; i < count; i++) {
      const item = list[i];
      if (item.fold) isFold[i] = 1;
      const kind = rowKinds[item.row];
      if (kind === undefined || kind === KIND_EQUAL) continue;
      isChange[i] = 1;
      if (kind === KIND_INSERT) isInsert[i] = 1;
    }

    // Change ticks: maximal runs of one kind become a single rectangle.
    const delColor = palette("--c-minimap-del");
    const insColor = palette("--c-minimap-ins");
    let runStart = 0;
    let runKind = 0;

    const flushRun = (end: number) => {
      if (runKind === 0 || end <= runStart) return;
      const y = runStart * unit;
      // At least 2px so a single changed line stays visible in a huge file.
      const h = Math.max(2, (end - runStart) * unit);
      c.fillStyle = runKind === 2 ? insColor : delColor;
      c.fillRect(1, y, w - 2, h);
    };

    for (let i = 0; i < count; i++) {
      const kind = isChange[i] ? (isInsert[i] ? 2 : 1) : 0;
      if (kind !== runKind) {
        flushRun(i);
        runStart = i;
        runKind = kind;
      }
    }
    flushRun(count);

    // Folded bands, under the indicator and weaker than the ticks.
    c.fillStyle = palette("--c-hatch-line");
    for (let i = 0; i < count; i++) {
      if (!isFold[i]) continue;
      let j = i;
      while (j < count && isFold[j]) j++;
      c.fillRect(0, i * unit, w, Math.max(1, (j - i) * unit));
      i = j - 1;
    }

    void rowH;
    return off;
  }

  /**
   * Composite: static layer + viewport indicator.
   *
   * This is the whole per-scroll cost, and it is O(1).
   */
  function paint(): void {
    const el = canvas;
    if (!el) return;

    const dpr = window.devicePixelRatio || 1;
    const w = metrics.minimapWidth;
    const mapHeight = height;
    if (mapHeight <= 0) return;

    const list = items;
    const count = list.length;
    const rowH = rowHeight;

    /*
     * Cache key: everything the static layer's pixels depend on.
     *
     * The palette is included because switching theme changes every colour in the
     * strip — without it the map would keep the previous theme's ticks until some
     * other input happened to change.
     */
    const key = [
      count,
      mapHeight,
      w,
      dpr,
      rowKinds.length,
      list.reduce((acc, it) => acc + (it.fold ? 1 : 0), 0),
      // The static layer's vertical scale now depends on how many rows fit in the
      // pane, so a resized window must invalidate it; otherwise the ticks keep the
      // previous height's positions.
      clientHeight,
      rowH,
      palette("--c-minimap-del"),
      palette("--c-minimap-ins"),
      palette("--c-minimap-bg"),
      palette("--c-hatch-line"),
    ].join(":");
    if (!staticLayer || key !== staticKey) {
      staticLayer = buildStaticLayer(w, mapHeight, dpr, list, rowH, clientHeight);
      staticKey = key;
    }

    const ctx = el.getContext("2d");
    if (!ctx) return;

    if (el.width !== Math.round(w * dpr) || el.height !== Math.round(mapHeight * dpr)) {
      el.width = Math.round(w * dpr);
      el.height = Math.round(mapHeight * dpr);
      el.style.width = `${w}px`;
      el.style.height = `${mapHeight}px`;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, el.width, el.height);
    ctx.drawImage(staticLayer, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (count === 0) return;

    /*
     * The indicator obeys the same `span` mapping as the ticks, and it is the
     * scrollbar thumb rescaled: the visible part of the document is
     * `clientHeight` tall in a document of `count * rowH`, so on the strip it is
     * `usedHeight * viewRatio` tall and travels the rest of `usedHeight`.
     *
     * Note it travels over `usedHeight`, not `mapHeight`: when the document is
     * shorter than the pane the strip's lower part represents nothing, and letting
     * the band drift into it would put the indicator somewhere no scroll position
     * can reach.
     *
     * Clamping happens for drawing only. Clamping first and then deriving the
     * offset from the clamped value is what made the old version drift as the
     * minimum height engaged.
     */
    const { usedHeight } = minimapScale(count, mapHeight, rowH, clientHeight);
    const totalHeight = Math.max(1, count * rowH);

    /*
     * The band reflects the scroll range, which is now exactly the document.
     *
     * It has to be derived from the *scroll* range and not from an assumed one:
     * when the port carried trailing padding, measuring against the document alone
     * made the band claim a larger viewport than there was, so it stopped rising
     * near the bottom while the code kept moving.
     */
    const portHeight = Math.max(1, totalHeight);
    const viewRatio = Math.min(1, clientHeight / portHeight);
    const scrollRatio = Math.min(
      1,
      Math.max(0, scrollTop / Math.max(1, portHeight - clientHeight)),
    );

    const exactHeight = usedHeight * viewRatio;
    const travel = Math.max(0, usedHeight - exactHeight);
    const top = Math.round(scrollRatio * travel);
    const viewHeight = Math.max(4, Math.round(exactHeight));

    ctx.fillStyle = palette("--c-minimap-viewport");
    ctx.fillRect(0, top, w, viewHeight);

    if (viewHeight >= 8) {
      ctx.strokeStyle = palette("--c-border-strong");
      ctx.lineWidth = 1;
      ctx.strokeRect(0.5, top + 0.5, w - 1, viewHeight - 1);
    }
  }

  /** Coalesce repaints: scroll fires far more often than the display refreshes. */
  function schedulePaint(): void {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      paint();
    });
  }

  /**
   * Repaint on any input change.
   *
   * Reading the reactive values here subscribes the effect to them; drawing is
   * deferred to `schedulePaint`, so several state changes in one tick still produce
   * one frame.
   *
   * The cache is not invalidated by a counter: a counter written *inside* this
   * effect is also *read* by it, so Svelte would re-run the effect forever. The
   * cache key in `paint()` is derived from the actual inputs instead, which is both
   * loop-free and self-correcting — if any input changes, the key changes too.
   */
  $effect(() => {
    // Touch every input so Svelte tracks it.
    void items;
    void rowKinds;
    void rowHeight;
    void clientHeight;
    void scrollTop;
    void height;

    schedulePaint();
  });

  // Cancel a pending frame on teardown so it cannot run against a dead canvas.
  $effect(() => () => {
    if (frame) cancelAnimationFrame(frame);
  });
</script>

<!--
  The strip is an overlay, not a column.

  It used to be a flex sibling of the panes, which reserved 10px of width on the
  right of every comparison — permanent space taken from the code for a control
  that is only useful while scrolling. As an absolutely-positioned overlay it costs
  no layout and can hide completely.
-->
<div
  class="minimap"
  class:visible
  class:dragging
  bind:this={track}
  bind:clientHeight={height}
  onpointerdown={onPointerDown}
  onpointermove={onPointerMove}
  onpointerup={onPointerUp}
  onpointercancel={onPointerUp}
  onpointerenter={() => {
    pointerInside = true;
    hider.hover(true);
  }}
  onpointerleave={() => {
    pointerInside = false;
    hider.hover(false);
  }}
  onkeydown={onKeyDown}
  role="scrollbar"
  aria-controls="diff-view"
  aria-valuenow={Math.round(viewStart)}
  aria-valuetext={$t("minimap.position", { index: Math.round(viewStart) + 1, total })}
  tabindex="0"
  title={$t("minimap.jumpTitle")}
>
  <canvas bind:this={canvas}></canvas>
</div>

<style>
  /*
   * An overlay pinned to the right edge of the pane column.
   *
   * `position: absolute` inside the `.split` container means it takes no width —
   * the panes get the full area back. `pointer-events: none` while hidden is what
   * makes hiding real rather than cosmetic: an invisible 10px strip that still ate
   * clicks would be worse than a visible one.
   */
  .minimap {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 2;
    width: var(--minimap-width);
    cursor: pointer;
    border-left: 1px solid var(--c-border);
    background: var(--c-minimap-bg);
    /*
     * Not `contain: strict`: size containment would make this element ignore its
     * own content box, and the strip is sized by its parent, so the canvas could
     * be laid out at zero height.
     */
    contain: layout paint;
    /* Dragging must not select text or pan-scroll the strip itself. */
    touch-action: none;

    /* Hidden by default; `visible` fades it in. */
    opacity: 0;
    pointer-events: none;
    transition: opacity 160ms ease;
  }

  /*
   * No transition on the way in when the user is actively scrolling.
   *
   * A fade-in during a scroll reads as lag: the strip is answering "where am I",
   * and that answer is wanted immediately. The fade is kept for the way out only.
   */
  .minimap.visible {
    opacity: 1;
    pointer-events: auto;
    transition: opacity 60ms ease;
  }

  .minimap.dragging {
    cursor: grabbing;
  }

  .minimap:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--c-accent);
  }

  canvas {
    display: block;
    pointer-events: none;
  }
</style>
