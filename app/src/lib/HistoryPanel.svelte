<script lang="ts">
  /**
   * Comparison history sheet.
   *
   * A side sheet like the git and settings panels, and for the same reason: the
   * list is only useful against the thing it reopens, so covering the diff with a
   * modal would hide the context.
   *
   * ## Grouping
   *
   * Rows are grouped by day (今天 / 昨天 / a date). An absolute timestamp per row
   * makes a list of twenty comparisons unreadable — what matters is "is this from
   * today or from last week", and that is a group header, not a field.
   */
  import {
    dayGroup,
    formatSize,
    formatTime,
    type HistorySummary,
  } from "../lib/history";
  import { t } from "../lib/i18nStore";

  interface Props {
    entries: HistorySummary[];
    loading: boolean;
    /** Ids the user has selected for opening; empty means "just browsing". */
    onOpen: (id: string) => void;
    onDelete: (id: string) => void;
    onClear: () => void;
    onClose: () => void;
  }

  let { entries, loading, onOpen, onDelete, onClear, onClose }: Props = $props();

  /** Grouped rows, in the order the backend returned them (newest first). */
  const groups = $derived.by(() => {
    const now = Date.now();
    const labels = { today: $t("history.today"), yesterday: $t("history.yesterday") };
    const out: { label: string; rows: HistorySummary[] }[] = [];
    for (const entry of entries) {
      const label = dayGroup(entry.createdAt, now, labels);
      const last = out.at(-1);
      if (last && last.label === label) last.rows.push(entry);
      else out.push({ label, rows: [entry] });
    }
    return out;
  });

  /** Two-stage clear: the button asks once, because this cannot be undone. */
  let confirmingClear = $state(false);

  function onClearClick(): void {
    if (!confirmingClear) {
      confirmingClear = true;
      return;
    }
    confirmingClear = false;
    onClear();
  }

  /** Escape closes the sheet, matching the other panels. */
  function onKeydown(event: KeyboardEvent): void {
    if (event.key !== "Escape") return;
    event.preventDefault();
    if (confirmingClear) confirmingClear = false;
    else onClose();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<aside class="sheet" aria-label={$t("history.title")}>
  <div class="head">
    <h2>{$t("history.title")}</h2>
    <button type="button" class="close" onclick={onClose} title={$t("history.close")} aria-label={$t("history.close")}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
      </svg>
    </button>
  </div>

  <div class="scroll">
    {#if loading && entries.length === 0}
      <p class="empty">{$t("history.loading")}</p>
    {:else if entries.length === 0}
      <!--
        An empty list needs to say *why*: "nothing recorded yet" and "your
        retention window deleted everything" look identical, and only one of them
        means the user should change a setting.
      -->
      <p class="empty">{$t("history.empty")}</p>
      <p class="hint">{$t("history.emptyHint")}</p>
    {:else}
      {#each groups as group (group.label)}
        <div class="group-label">{group.label}</div>
        {#each group.rows as entry (entry.id)}
          <div class="row">
            <button
              type="button"
              class="open"
              onclick={() => onOpen(entry.id)}
              title={`${entry.leftLabel} ↔ ${entry.rightLabel}`}
            >
              <span class="names">
                <span class="name">{entry.leftLabel || $t("side.pasted")}</span>
                <span class="arrow" aria-hidden="true">↔</span>
                <span class="name">{entry.rightLabel || $t("side.pasted")}</span>
              </span>
              <span class="meta">
                <span class="time">{formatTime(entry.createdAt)}</span>
                <span class="size">{formatSize(entry.size)}</span>
                {#if entry.hasPaths}
                  <span class="tag">{$t("history.fromFiles")}</span>
                {/if}
              </span>
            </button>
            <button
              type="button"
              class="del"
              title={$t("history.delete")}
              aria-label={$t("history.delete")}
              onclick={() => onDelete(entry.id)}
            >
              <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
                <path
                  d="M4.5 4.5l7 7M11.5 4.5l-7 7"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.5"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
        {/each}
      {/each}
    {/if}
  </div>

  <footer class="foot">
    <button
      type="button"
      class="clear"
      class:confirming={confirmingClear}
      disabled={entries.length === 0}
      onclick={onClearClick}
    >
      {confirmingClear ? $t("history.clearConfirm") : $t("history.clearAll")}
    </button>
    <span class="note">{$t("history.retentionNote")}</span>
  </footer>
</aside>

<style>
  .sheet {
    flex: 0 0 320px;
    display: flex;
    flex-direction: column;
    min-height: 0;
    border-left: 1px solid var(--c-border);
    background: var(--c-bg-elevated);
  }

  .head {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 36px;
    padding: 0 8px 0 12px;
    border-bottom: 1px solid var(--c-border);
  }

  h2 {
    margin: 0;
    font-size: 12px;
    font-weight: 590;
    color: var(--c-text);
  }

  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 5px;
    background: transparent;
    color: var(--c-text-muted);
    cursor: pointer;
  }

  .close:hover {
    background: var(--c-bg-sunken);
    color: var(--c-text);
  }

  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding-bottom: 8px;
  }

  /* Sticky group headers: scrolling a long list keeps the day visible. */
  .group-label {
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 6px 12px 4px;
    background: var(--c-bg-elevated);
    font-size: 10px;
    font-weight: 590;
    letter-spacing: 0.04em;
    color: var(--c-text-faint);
  }

  .row {
    display: flex;
    align-items: stretch;
    gap: 2px;
    padding: 0 6px 0 4px;
  }

  .open {
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 5px 6px;
    border: none;
    border-radius: 5px;
    background: transparent;
    font: inherit;
    text-align: left;
    color: var(--c-text);
    cursor: pointer;
  }

  .open:hover {
    background: var(--c-bg-sunken);
  }

  .open:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px var(--c-accent);
  }

  /* Two filenames on one line, each clipped independently so neither vanishes. */
  .names {
    display: flex;
    align-items: baseline;
    gap: 4px;
    min-width: 0;
    font-size: 11px;
  }

  .name {
    flex: 0 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .arrow {
    flex: 0 0 auto;
    color: var(--c-text-faint);
  }

  .meta {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 10px;
    color: var(--c-text-faint);
  }

  .time {
    font-variant-numeric: tabular-nums;
  }

  .size {
    font-variant-numeric: tabular-nums;
  }

  .tag {
    padding: 0 3px;
    border-radius: 3px;
    background: var(--c-selection);
    color: var(--c-text-muted);
  }

  .del {
    flex: 0 0 auto;
    align-self: center;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 4px;
    background: transparent;
    color: var(--c-text-faint);
    cursor: pointer;
    opacity: 0;
  }

  /* The delete affordance appears on hover, like the tab close button: a column
     of × marks would compete with the filenames, which are the content. */
  .row:hover .del {
    opacity: 1;
  }

  .del:hover {
    background: var(--c-del-row);
    color: var(--c-del-gutter-text);
  }

  .del:focus-visible {
    opacity: 1;
    outline: none;
    box-shadow: 0 0 0 2px var(--c-accent);
  }

  .empty {
    margin: 0;
    padding: 16px 12px 4px;
    font-size: 11px;
    color: var(--c-text-muted);
  }

  .hint {
    margin: 0;
    padding: 0 12px;
    font-size: 10px;
    line-height: 1.5;
    color: var(--c-text-faint);
  }

  .foot {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--c-border);
  }

  .clear {
    flex: 0 0 auto;
    padding: 2px 8px;
    border: 1px solid var(--c-border);
    border-radius: 5px;
    background: var(--c-bg);
    font: inherit;
    font-size: 11px;
    color: var(--c-text-muted);
    cursor: pointer;
  }

  .clear:hover:not(:disabled) {
    border-color: var(--c-border-strong);
    color: var(--c-text);
  }

  /* Armed state: the second click is destructive, and it should look it. */
  .clear.confirming {
    border-color: var(--c-del-edge);
    color: var(--c-del-gutter-text);
  }

  .clear:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .note {
    flex: 1 1 auto;
    font-size: 9.5px;
    line-height: 1.4;
    text-align: right;
    color: var(--c-text-faint);
  }
</style>
