<script lang="ts">
  /**
   * First-run screen: two bare text panes separated by one vertical rule.
   *
   * Design intent — no cards.
   *
   * An earlier version wrapped each side in a bordered, elevated panel with its
   * own header strip. That read as two "cards" floating on a background, which is
   * the look of a blank-state form rather than of an editor: the content had an
   * outline around it before it had any content. Here the two panes go edge to
   * edge and are just white; the only chrome is a hairline between them, so the
   * window reads as one surface split in two.
   *
   * Input is direct: paste into either side and the comparison runs. There is no
   * "start" step, because having to press a button after pasting is pure ceremony
   * — the two blocks are the entire request. Files can be dropped or picked, and
   * are read through the backend so a large file never round-trips through the
   * clipboard.
   */
  import { onMount } from "svelte";
  import type { PasteBlock, PastePair, SideName } from "../lib/types";
  import { t } from "../lib/i18nStore";

  interface Props {
    /**
     * Load a dropped path into a side.
     *
     * Returns the block instead of letting the parent own the text: the textarea
     * must show exactly what the diff will compare, so the loaded content has to
     * land in this component's state.
     */
    onDrop: (side: SideName, path: string) => Promise<PasteBlock | null>;
    /** Open a native file picker for one side and load the chosen file. */
    onPickFile: (side: SideName) => Promise<PasteBlock | null>;
    /** Both sides have content; the parent commits them as one comparison. */
    onCompare: (pair: PastePair) => void;
  }

  let { onDrop, onPickFile, onCompare }: Props = $props();

  let left = $state<PasteBlock>({ text: "", path: null, label: "" });
  let right = $state<PasteBlock>({ text: "", path: null, label: "" });
  let focused = $state<SideName | null>(null);
  let dragSide = $state<SideName | null>(null);
  /**
   * Handle from the trailing debounce.
   *
   * Comparing on every keystroke would re-send the whole document per character;
   * a short trailing delay is imperceptible and collapses a burst of typing into
   * one request.
   */
  let timer: ReturnType<typeof setTimeout> | null = null;

  function blockFor(side: SideName): PasteBlock {
    return side === "left" ? left : right;
  }

  function textFor(side: SideName): string {
    return blockFor(side).text;
  }

  /**
   * Commit both sides to the parent when both have content.
   *
   * Comparing needs two documents: with only one side filled there is nothing to
   * compare against, so no request is made and the screen simply stays put.
   */
  function scheduleCompare(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (left.text === "" || right.text === "") return;
      onCompare({ left, right });
    }, 120);
  }

  /**
   * Set a side's text.
   *
   * Typing over an imported file clears its `path`: the buffer no longer matches
   * what is on disk, and `⌘S` must not silently overwrite the original with a
   * half-finished edit. The strip says so by dropping the filename.
   */
  function setText(side: SideName, value: string): void {
    const next: PasteBlock = { text: value, path: null, label: "" };
    if (side === "left") left = next;
    else right = next;
    scheduleCompare();
  }

  /** Apply a block loaded from a file, replacing whatever that side held. */
  function applyFile(side: SideName, block: PasteBlock): void {
    if (side === "left") left = block;
    else right = block;
    scheduleCompare();
  }

  function clearSide(side: SideName): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (side === "left") left = { text: "", path: null, label: "" };
    else right = { text: "", path: null, label: "" };
    focusSide(side);
  }

  function focusSide(side: SideName): void {
    document
      .querySelector<HTMLTextAreaElement>(`textarea[data-side="${side}"]`)
      ?.focus();
  }

  /**
   * `Tab` crosses to the other side; every other key types normally.
   *
   * There is no "compare" key: the comparison is automatic and continuous, so a
   * commit key would be a no-op that also steals Enter from people adding lines.
   */
  function handleKey(event: KeyboardEvent, side: SideName): void {
    if (event.key !== "Tab") return;
    event.preventDefault();
    focusSide(side === "left" ? "right" : "left");
  }

  function over(event: DragEvent, side: SideName): void {
    event.preventDefault();
    dragSide = side;
  }

  async function drop(event: DragEvent, side: SideName): Promise<void> {
    dragSide = null;
    const file = event.dataTransfer?.files?.[0] as (File & { path?: string }) | undefined;
    if (!file?.path) return;
    event.preventDefault();
    const block = await onDrop(side, file.path);
    if (block) applyFile(side, block);
  }

  async function pick(side: SideName): Promise<void> {
    const block = await onPickFile(side);
    if (block) applyFile(side, block);
  }

  /** Line count for the strip, matching the backend's line model. */
  function linesOf(text: string): number {
    if (text === "") return 0;
    return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  }

  // Open focused so the first ⌘V needs no click.
  onMount(() => focusSide("left"));
</script>

<div class="home">
  {#each ["left", "right"] as const as side (side)}
    {@const text = textFor(side)}
    {@const block = blockFor(side)}
    {@const count = linesOf(text)}
    {@const otherEmpty = textFor(side === "left" ? "right" : "left") === ""}
    <section
      class="pane"
      class:dragging={dragSide === side}
      ondragover={(e) => over(e, side)}
      ondragleave={() => (dragSide = null)}
      ondrop={(e) => drop(e, side)}
      aria-label={side === "left" ? $t("side.leftContent") : $t("side.rightContent")}
    >
      <!--
        A 26px strip, not a card header: one label on the left, quiet actions on
        the right. It carries no border or background of its own, so it reads as
        a line of text above the code rather than as a title bar.
      -->
      <div class="strip">
        <span class="tag">{side === "left" ? $t("side.left") : $t("side.right")}</span>
        {#if block.path}
          <span class="file" title={block.path}>{block.path.split("/").pop()}</span>
        {:else if count > 0}
          <span class="count">{$t("edit.lines", { n: count })}</span>
        {/if}

        <span class="grow"></span>

        {#if count > 0}
          <button class="act" onclick={() => clearSide(side)} title={$t("home.clearSide")}>{$t("home.clear")}</button>
        {/if}
        <button class="act" onclick={() => void pick(side)} title={$t("home.importFile")}>{$t("home.importFile")}</button>
      </div>

      <div class="field">
        <textarea
          value={text}
          oninput={(e) => setText(side, e.currentTarget.value)}
          data-side={side}
          onfocus={() => (focused = side)}
          onblur={() => {
            if (focused === side) focused = null;
          }}
          onkeydown={(e) => handleKey(e, side)}
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          aria-label={side === "left" ? $t("side.leftContent") : $t("side.rightContent")}
        ></textarea>

        {#if text === ""}
          <!--
            One line, and it changes with the state of the screen.

            The earlier version stacked two lines ("粘贴文本，或拖入文件" plus
            "点击此处聚焦") under a ⌘V key cap. All three parts were either
            redundant or wrong:

            - "点击此处聚焦" describes something clicking plainly does; it is an
              instruction for a control that has no alternative, and it vanished
              on focus, which made the block jump for no reason.
            - The ⌘V cap assumed the pilot's clipboard already held the text. The
              common case is the opposite: you read this line *before* you have
              copied anything, so "paste here" answers a question nobody asked.
            - "或拖入文件" buried the second input method inside a sentence about
              the first.

            What is left is the one thing the empty state cannot show: that this
            side is waiting for something, and that a file works too. Once the
            other side has content the message changes, because then the useful
            information is that this comparison is still half-done.
          -->
          <div class="hint" aria-hidden="true">
            {otherEmpty ? $t("home.hintBothEmpty") : $t("home.hintOtherFilled")}
          </div>
        {/if}
      </div>
    </section>

    {#if side === "left"}
      <div class="rule" role="presentation"></div>
    {/if}
  {/each}
</div>

<style>
  .home {
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
    min-width: 0;
    /* Pure page background: the panes are the only surfaces, with no frame. */
    background: var(--c-bg);
  }

  /*
   * Panes go edge to edge. No border, no radius, no elevated fill: the split is
   * communicated by the single vertical rule between them and by nothing else.
   */
  .pane {
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--c-bg);
  }

  /* Drop feedback replaces the card outline with a soft wash and an inset edge. */
  .pane.dragging {
    background: var(--c-selection);
    box-shadow: inset 0 0 0 1px var(--c-accent);
  }

  /* --- strip ------------------------------------------------------------ */
  .strip {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 6px;
    height: 26px;
    padding: 0 12px;
    font-size: 11px;
    color: var(--c-text-faint);
    user-select: none;
  }

  .tag {
    font-weight: 590;
    color: var(--c-text-muted);
  }

  .file {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 22ch;
    color: var(--c-text-muted);
    font-family: var(--font-mono);
  }

  .count {
    font-variant-numeric: tabular-nums;
  }

  .grow {
    flex: 1 1 auto;
  }

  /*
   * Strip actions are text until hovered. A borderless button in a 26px row keeps
   * the strip from looking like a toolbar, and the hover fill is the only
   * affordance it needs.
   */
  .act {
    height: 20px;
    padding: 0 6px;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--c-text-faint);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }

  .act:hover {
    background: var(--c-bg-sunken);
    color: var(--c-text);
  }

  /* --- field ------------------------------------------------------------ */
  .field {
    position: relative;
    flex: 1 1 auto;
    display: flex;
    min-height: 0;
  }

  textarea {
    flex: 1 1 auto;
    width: 100%;
    min-height: 0;
    padding: 2px 12px 12px;
    border: none;
    outline: none;
    resize: none;
    background: transparent;
    color: var(--c-text);
    font-family: var(--font-mono);
    font-size: var(--font-size-code);
    line-height: var(--row-height);
    caret-color: var(--c-accent);
    white-space: pre;
    overflow: auto;
    tab-size: 4;
  }

  /* Centred and quiet: the empty window should look calm, not instructional. */
  .hint {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    /*
     * One short line at 12px, faint but not invisible. No key caps, no second
     * line, no icon: an empty pane with a single sentence reads as "waiting",
     * while a stack of instructions reads as a form to fill in.
     */
    font-size: 12px;
    color: var(--c-text-faint);
    pointer-events: none;
    user-select: none;
  }

  /* --- divider ---------------------------------------------------------- */
  /*
   * The only structural line on the screen. A hairline, full height, flush with
   * both panes: no grab handle, no dots, no hover thickening. It is a boundary,
   * not a control — the split is adjusted from the toolbar instead, which keeps
   * this screen looking like one document.
   */
  .rule {
    flex: 0 0 1px;
    background: var(--c-border);
  }
</style>
