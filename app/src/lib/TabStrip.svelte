<script lang="ts">
  /**
   * Tab strip.
   *
   * Deliberately thin: a row of tabs and a "+" button, no overflow menu and no
   * grouping. Comparisons are opened a few at a time and closed soon after; the
   * moment a tab strip needs a scrollbar or a dropdown, the real problem is that
   * too many are open, not that the strip is too small.
   *
   * ## Why the close button is inside the tab, not on the tab edge
   *
   * The whole tab is the click target for activation, so a close affordance drawn
   * at the edge would either shrink the activation area or close the tab when the
   * user meant to switch to it. Keeping the button a distinct child means the two
   * actions never compete for the same pixels, and `stopPropagation` makes the
   * intent explicit rather than relying on hit-area arithmetic.
   *
   * ## Middle-click
   *
   * Closes, like every browser. This is the one convention users bring from
   * elsewhere without being told, so it is implemented even though the app has no
   * other middle-click behaviour.
   */
  import type { Tab } from "../lib/tabs";
  import { hasContent, numberLabels, tabLabel } from "../lib/tabs";
  import { t } from "../lib/i18nStore";
  import { tick } from "svelte";

  interface Props {
    tabs: Tab[];
    activeId: string | null;
    /** Label used when a tab's sides were both pasted, so it has no filename. */
    pastedLabel: string;
    /** Label for a tab created with "+" that has not been filled in yet. */
    untitledLabel: string;
    onActivate: (id: string) => void;
    onClose: (id: string) => void;
    onRename: (id: string, name: string) => void;
    onNew: () => void;
    /** Reorder by dragging; `to` is the destination index. */
    onMove: (from: number, to: number) => void;
  }

  let { tabs, activeId, pastedLabel, untitledLabel, onActivate, onClose, onRename, onNew, onMove }:
    Props = $props();

  let dragging = $state<number | null>(null);
  let editingId = $state<string | null>(null);
  let draftName = $state("");
  let renameInput = $state<HTMLInputElement | null>(null);

  /*
   * Labels, disambiguated.
   *
   * The raw label is what the tab *is*; several blank tabs are all "New
   * comparison", and three identical tabs give the user nothing to aim at. The
   * numbering is computed over the whole strip at once, so it renumbers when a tab
   * is closed instead of leaving gaps.
   */
  const labels = $derived(
    numberLabels(
      tabs,
      (tab) => tabLabel(tab.session, pastedLabel, untitledLabel, tab.name),
      // A blank tab is always potentially one of several, so it is numbered from
      // the start; a filename or explicit custom name is not.
      (tab) => tab.name === null && !hasContent(tab.session),
    ),
  );

  function onDragStart(event: DragEvent, index: number): void {
    if (editingId !== null) {
      event.preventDefault();
      return;
    }
    dragging = index;
    // Firefox refuses to start a drag without payload data.
    event.dataTransfer?.setData("text/plain", String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }

  function onDragOver(event: DragEvent, index: number): void {
    if (dragging === null || dragging === index) return;
    // Only preventDefault on a valid target, or the drop cursor appears everywhere.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
  }

  function onDrop(event: DragEvent, index: number): void {
    event.preventDefault();
    if (dragging !== null && dragging !== index) onMove(dragging, index);
    dragging = null;
  }

  function onDragEnd(): void {
    dragging = null;
  }

  async function focusRenameInput(id: string): Promise<void> {
    await tick();
    // WebKit applies the click's default focus after the event handlers return.
    // Focusing synchronously here would be undone a moment later, and the blur
    // handler would commit before the user can type a single character.
    requestAnimationFrame(() => {
      if (editingId !== id || renameInput === null) return;
      renameInput.focus();
      renameInput.select();
    });
  }

  function beginRename(tab: Tab): void {
    draftName = tab.name ?? tabLabel(tab.session, pastedLabel, untitledLabel);
    editingId = tab.id;
    void focusRenameInput(tab.id);
  }

  function commitRename(id: string): void {
    if (editingId !== id) return;
    const name = draftName;
    editingId = null;
    onRename(id, name);
  }

  function cancelRename(): void {
    editingId = null;
    draftName = "";
  }
</script>

<div class="tabstrip" role="tablist" aria-label={$t("tabs.label")}>
  {#each tabs as tab, index (tab.id)}
    {@const label = labels[index]}
    <div
      class="tab"
      class:active={tab.id === activeId}
      class:dragging={dragging === index}
      class:editing={editingId === tab.id}
      role="tab"
      aria-selected={tab.id === activeId}
      tabindex={tab.id === activeId ? 0 : -1}
      title={editingId === tab.id ? undefined : `${label} · ${$t("tabs.renameHint")}`}
      draggable={editingId !== tab.id}
      ondragstart={(e) => onDragStart(e, index)}
      ondragover={(e) => onDragOver(e, index)}
      ondrop={(e) => onDrop(e, index)}
      ondragend={onDragEnd}
      onclick={() => onActivate(tab.id)}
      ondblclick={(e) => {
        if (editingId !== null) return;
        e.preventDefault();
        e.stopPropagation();
        beginRename(tab);
      }}
      onauxclick={(e) => {
        if (e.button === 1) {
          e.preventDefault();
          onClose(tab.id);
        }
      }}
      onkeydown={(e) => {
        if (editingId === tab.id) return;
        if (e.key === "F2") {
          e.preventDefault();
          e.stopPropagation();
          beginRename(tab);
          return;
        }
        // Enter/Space activate, matching every other focusable control.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate(tab.id);
        }
      }}
    >
      {#if editingId === tab.id}
        <input
          class="rename-input"
          type="text"
          bind:this={renameInput}
          bind:value={draftName}
          aria-label={$t("tabs.rename")}
          onblur={() => commitRename(tab.id)}
          onclick={(e) => e.stopPropagation()}
          ondblclick={(e) => e.stopPropagation()}
          onkeydown={(e) => {
            // Keep application shortcuts out of the rename field.
            e.stopPropagation();
            if (e.isComposing) return;
            if (e.key === "Enter") {
              e.preventDefault();
              commitRename(tab.id);
            } else if (e.key === "Escape") {
              e.preventDefault();
              cancelRename();
            }
          }}
        />
      {:else}
        <span class="label">{label}</span>
      {/if}
      <button
        type="button"
        class="close"
        title={$t("tabs.close")}
        aria-label={$t("tabs.close")}
        ondblclick={(e) => e.stopPropagation()}
        onclick={(e) => {
          // Without this the tab's own click handler would also fire and activate
          // the tab being closed.
          e.stopPropagation();
          onClose(tab.id);
        }}
      >
        <svg viewBox="0 0 16 16" width="9" height="9" aria-hidden="true">
          <path
            d="M4 4l8 8M12 4l-8 8"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </div>
  {/each}

  <button type="button" class="new" title={$t("tabs.new")} aria-label={$t("tabs.new")} onclick={onNew}>
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path
        d="M8 3.5v9M3.5 8h9"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>
  </button>
</div>

<style>
  /*
   * A 30px strip above the toolbar's own row.
   *
   * Height is fixed and small: tabs are a navigation affordance, and every pixel
   * spent here comes out of the two code panes below.
   */
  .tabstrip {
    flex: 0 0 auto;
    display: flex;
    align-items: stretch;
    height: 30px;
    padding: 0 6px;
    gap: 1px;
    overflow-x: auto;
    overflow-y: hidden;
    border-bottom: 1px solid var(--c-border);
    background: var(--c-bg-sunken);
    /* The strip scrolls horizontally when many tabs are open; the scrollbar must
       not add height, so it is hidden in favour of the trackpad/wheel. */
    scrollbar-width: none;
  }

  .tabstrip::-webkit-scrollbar {
    height: 0;
  }

  /*
   * Tabs are trapezoids in the AppKit sense: a tab reads as part of the page when
   * active (same fill as the pane background) and as recessed otherwise.
   */
  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 1 auto;
    min-width: 72px;
    max-width: 200px;
    padding: 0 6px 0 10px;
    border: 1px solid transparent;
    border-bottom: none;
    border-radius: 5px 5px 0 0;
    font-size: 11px;
    color: var(--c-text-muted);
    cursor: default;
    user-select: none;
    white-space: nowrap;
  }

  .tab:hover {
    background: var(--c-bg-elevated);
    color: var(--c-text);
  }

  .tab.active {
    background: var(--c-bg);
    border-color: var(--c-border);
    color: var(--c-text);
  }

  /* Dragging state: the tab being moved dims, so the drop target is legible. */
  .tab.dragging {
    opacity: 0.45;
  }

  .tab.editing {
    min-width: 148px;
    cursor: text;
  }

  .tab:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--c-accent);
  }

  .label {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rename-input {
    flex: 1 1 auto;
    min-width: 0;
    width: 100%;
    height: 20px;
    padding: 0 4px;
    border: 1px solid var(--c-accent);
    border-radius: 3px;
    outline: none;
    background: var(--c-bg);
    color: var(--c-text);
    font: inherit;
    user-select: text;
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--c-accent) 18%, transparent);
  }

  /*
   * The close button is invisible until the tab is hovered or active.
   *
   * Shown permanently it would be a row of × marks competing with the filenames,
   * which are the content of the strip. Hidden entirely it would be undiscoverable,
   * which is why the active tab always shows it.
   */
  .close {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 15px;
    height: 15px;
    padding: 0;
    border: none;
    border-radius: 3px;
    background: transparent;
    color: var(--c-text-faint);
    cursor: pointer;
    opacity: 0;
  }

  .tab:hover .close,
  .tab.active .close {
    opacity: 1;
  }

  .tab.editing .close {
    visibility: hidden;
    pointer-events: none;
  }

  .close:hover {
    background: var(--c-bg-sunken);
    color: var(--c-text);
  }

  .close:focus-visible {
    opacity: 1;
    outline: none;
    box-shadow: 0 0 0 2px var(--c-accent);
  }

  /* The new-tab button sits with the tabs but never grows. */
  .new {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    margin: 3px 0 3px 4px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--c-text-muted);
    cursor: pointer;
  }

  .new:hover {
    background: var(--c-bg-elevated);
    color: var(--c-text);
  }

  .new:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--c-accent);
  }
</style>
