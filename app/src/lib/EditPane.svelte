<script lang="ts">
  /**
   * Editable view of one side of a comparison.
   *
   * Why a whole-pane editor instead of per-line editing:
   *
   * The diff panes are virtualised — only the rows near the viewport exist in the
   * DOM. An in-place `contenteditable` row would therefore disappear (with its
   * cursor, selection and undo stack) the moment it scrolled out of the render
   * window, which in a 20k-line file is one flick of the wheel. Editable rows also
   * have to be re-measured as text changes, and the whole scrolling model assumes
   * a fixed row height.
   *
   * So editing happens on the *document*, not on a rendered row: this component
   * shows the side's full text in one textarea. It is the model the user actually
   * thinks in ("this file, line 481"), it keeps browser-native undo/redo and
   * find-in-page, and it costs no change to the virtual scroller because the diff
   * is recomputed from the new text when editing ends.
   */
  import type { SideName } from "../lib/types";
  import { t } from "../lib/i18nStore";

  interface Props {
    side: SideName;
    /** Current full text of this side. */
    text: string;
    /** Filename when the side came from disk, for the label. */
    path: string | null;
    /** Whether this pane currently has unsaved edits against the session. */
    dirty: boolean;
    onInput: (text: string) => void;
    /** Leave editing and re-run the comparison. */
    onDone: () => void;
    /** Abandon the edits. */
    onCancel: () => void;
  }

  let { side, text, path, dirty, onInput, onDone, onCancel }: Props = $props();

  /**
   * Keyboard handling lives on the textarea, not on a wrapping element.
   *
   * `keydown` from inside a focused textarea does bubble, but a handler on an
   * ancestor container only sees it if nothing closer stops propagation — and more
   * importantly the caret keys have to be decided here, next to the element that
   * owns the text. Esc therefore cancels from the editor itself.
   *
   * ⌘S is left alone so it still writes the file to disk.
   */
  function onKey(event: KeyboardEvent): void {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      onDone();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
    }
  }

  const name = $derived(path ? (path.split("/").pop() ?? path) : side === "left" ? $t("side.left") : $t("side.right"));
</script>

<section class="editor" aria-label={$t("edit.paneLabel", { side: side === "left" ? $t("side.left") : $t("side.right") })}>
  <!--
    A 26px strip matching the read-only pane's rhythm: name on the left, state on
    the right. No toolbar buttons — the only action is "done", which lives in the
    compare bar below so it applies to both sides at once.
  -->
  <div class="strip">
    <span class="name" title={path ?? ""}>{name}</span>
    {#if dirty}
      <span class="dirty">{$t("edit.dirty")}</span>
    {/if}
    <span class="lines">{$t("edit.lines", { n: text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0) })}</span>
  </div>

  <textarea
    value={text}
    oninput={(e) => onInput(e.currentTarget.value)}
    onkeydown={onKey}
    spellcheck="false"
    autocomplete="off"
    autocapitalize="off"
    aria-label={$t("edit.contentLabel", { side: side === "left" ? $t("side.left") : $t("side.right") })}
  ></textarea>
</section>

<style>
  /*
   * Fill the pane.
   *
   * `.side` is a column flex container with a percentage `flex-basis`, so its
   * height comes from the split, not from content. Without `flex: 1 1 auto` here
   * the editor sized itself to its content and collapsed to a couple of rows —
   * the textarea then had ~46px of visible height while the pane was 737px tall.
   */
  .editor {
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    height: 100%;
    background: var(--c-bg);
  }

  .strip {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 26px;
    padding: 0 12px;
    font-size: 11px;
    color: var(--c-text-faint);
    user-select: none;
  }

  .name {
    font-family: var(--font-mono);
    color: var(--c-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Amber rather than red: unsaved is a state to notice, not an error. */
  .dirty {
    color: #b45309;
    font-weight: 590;
  }

  .lines {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
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
    /* Soft wrap here, unlike the read-only panes: while typing, seeing the whole
       line matters more than column alignment, and there is no second pane to
       stay aligned with during editing. */
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    overflow: auto;
    tab-size: 4;
  }
</style>
