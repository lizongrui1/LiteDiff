<script lang="ts">
  import { onMount } from "svelte";
  import { t } from "../lib/i18nStore";

  interface Props {
    query: string;
    resultCount: number;
    /** Zero-based active result. */
    activeIndex: number;
    activeLine: number | null;
    caseSensitive: boolean;
    onQuery: (query: string) => void;
    onPrevious: () => void;
    onNext: () => void;
    onToggleCase: () => void;
    onClose: () => void;
  }

  let {
    query,
    resultCount,
    activeIndex,
    activeLine,
    caseSensitive,
    onQuery,
    onPrevious,
    onNext,
    onToggleCase,
    onClose,
  }: Props = $props();

  let input = $state<HTMLInputElement | null>(null);

  onMount(() => {
    input?.focus();
    input?.select();
  });

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) onPrevious();
      else onNext();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  const position = $derived(activeIndex + 1);
</script>

<div class="findbar" role="search" aria-label={$t("search.label")}>
  <svg class="search-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
    <circle cx="6.7" cy="6.7" r="4.3" fill="none" stroke="currentColor" stroke-width="1.35" />
    <path d="m10 10 3.3 3.3" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" />
  </svg>

  <input
    bind:this={input}
    value={query}
    oninput={(event) => onQuery(event.currentTarget.value)}
    onkeydown={onKeydown}
    placeholder={$t("search.placeholder")}
    aria-label={$t("search.label")}
    autocomplete="off"
    autocapitalize="off"
    spellcheck="false"
  />

  {#if query}
    <span class="count" class:empty={resultCount === 0} aria-live="polite" aria-atomic="true">
      {#if resultCount === 0}
        {$t("search.noResults")}
      {:else}
        <span>{$t("search.position", { index: position, total: resultCount })}</span>
        {#if activeLine !== null}<span class="line">L{activeLine}</span>{/if}
      {/if}
    </span>
  {/if}

  <button
    class="tool case"
    class:on={caseSensitive}
    onclick={onToggleCase}
    title={$t("search.caseSensitive")}
    aria-label={$t("search.caseSensitive")}
    aria-pressed={caseSensitive}
  >
    Aa
  </button>

  <span class="rule" aria-hidden="true"></span>

  <button
    class="tool"
    disabled={resultCount === 0}
    onclick={onPrevious}
    title={$t("search.previous")}
    aria-label={$t("search.previous")}
  >
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="m4.5 10 3.5-3.5 3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  <button
    class="tool"
    disabled={resultCount === 0}
    onclick={onNext}
    title={$t("search.next")}
    aria-label={$t("search.next")}
  >
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="m4.5 6 3.5 3.5L11.5 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  </button>
  <button
    class="tool"
    onclick={onClose}
    title={$t("search.close")}
    aria-label={$t("search.close")}
  >
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
      <path d="m4.5 4.5 7 7m0-7-7 7" fill="none" stroke="currentColor" stroke-width="1.45" stroke-linecap="round" />
    </svg>
  </button>
</div>

<style>
  .findbar {
    position: absolute;
    z-index: 24;
    top: 10px;
    right: 18px;
    display: flex;
    align-items: center;
    gap: 3px;
    width: min(430px, calc(100% - 36px));
    height: 38px;
    padding: 4px 5px 4px 10px;
    border: 1px solid color-mix(in srgb, var(--c-border-strong) 78%, transparent);
    border-radius: 10px;
    background: color-mix(in srgb, var(--c-bg-elevated) 94%, transparent);
    box-shadow:
      0 8px 22px rgba(0, 0, 0, 0.12),
      0 1px 2px rgba(0, 0, 0, 0.08);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
  }

  .search-icon {
    flex: 0 0 auto;
    color: var(--c-text-faint);
  }

  input {
    flex: 1 1 auto;
    min-width: 60px;
    height: 28px;
    padding: 0 5px;
    border: none;
    outline: none;
    background: transparent;
    color: var(--c-text);
    font: inherit;
    font-size: 13px;
    user-select: text;
  }

  input::placeholder {
    color: var(--c-text-faint);
  }

  .count {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
    color: var(--c-text-muted);
    font-family: var(--font-mono);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .count.empty {
    color: var(--c-del-edge);
    font-family: inherit;
  }

  .line {
    color: var(--c-text-faint);
  }

  .tool {
    flex: 0 0 27px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 27px;
    height: 27px;
    padding: 0;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--c-text-muted);
    font: inherit;
    cursor: pointer;
  }

  .tool:hover:not(:disabled) {
    background: var(--c-bg-sunken);
    color: var(--c-text);
  }

  .tool.on {
    background: color-mix(in srgb, var(--c-accent) 16%, transparent);
    color: var(--c-accent);
  }

  .tool:disabled {
    opacity: 0.32;
    cursor: default;
  }

  .case {
    font-family: var(--font-mono);
    font-size: 10px;
    font-weight: 650;
    letter-spacing: -0.04em;
  }

  .rule {
    flex: 0 0 1px;
    width: 1px;
    height: 18px;
    margin: 0 2px;
    background: var(--c-border);
  }
</style>
