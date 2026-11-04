<script lang="ts">
  /**
   * "Nothing changed" banner.
   *
   * A comparison that finds no differences still renders a full-height document,
   * and that document looks exactly like a diff whose changes happen to be off
   * screen. Without a statement at the top the user scrolls the whole file hunting
   * for a highlight that does not exist — so the banner answers the question
   * before the scrolling starts.
   *
   * It is dismissible because it costs vertical space, and it does not reappear
   * until the comparison changes again: dismissing an answer you have already read
   * should stick.
   */

  interface Props {
    /** Total lines compared, for the summary line. */
    lines: number;
    /** Options in effect, so the banner can say what was actually compared. */
    ignoring: string[];
    onDismiss: () => void;
  }

  import { t } from "../lib/i18nStore";

  let { lines, ignoring, onDismiss }: Props = $props();
</script>

<div class="banner" role="status">
  <span class="dot" aria-hidden="true">
    <svg viewBox="0 0 16 16" width="13" height="13">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4" />
      <path
        d="m5.4 8.2 1.9 1.9 3.5-3.9"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  </span>

  <span class="text">
    <span class="title">{$t("same.title")}</span>
    <span class="detail">
      $t("same.detailLines", { lines })}{ignoring.length > 0
        ? $t("same.ignoring", { options: ignoring.join("、") })
        : ""}
    </span>
  </span>

  <button class="close" onclick={onDismiss} title={$t("same.dismissTitle")} aria-label={$t("same.dismissTitle")}>
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path
        d="m4.5 4.5 7 7m0-7-7 7"
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-linecap="round"
      />
    </svg>
  </button>
</div>

<style>
  /*
   * A tinted strip, not a floating card: it spans the window, sits directly under
   * the toolbar, and pushes the content down rather than covering it. Overlaying
   * would hide the first lines of the very document the user is checking.
   *
   * The accent hue is reused at very low alpha so the banner inherits the user's
   * chosen accent instead of introducing a sixth colour into a palette that is
   * deliberately narrow.
   */
  .banner {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 12px;
    border-bottom: 1px solid var(--c-border);
    background: color-mix(in srgb, var(--c-accent) 7%, var(--c-bg));
    color: var(--c-text);
    font-size: 12px;
  }

  .dot {
    display: inline-flex;
    align-items: center;
    color: #1f9d55;
  }

  .text {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
  }

  .title {
    font-weight: 590;
  }

  .detail {
    color: var(--c-text-muted);
    font-variant-numeric: tabular-nums;
    /* One line only: a wrapping banner would take over the viewport it describes. */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .close {
    margin-left: auto;
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
  }

  .close:hover {
    background: var(--c-bg-sunken);
    color: var(--c-text);
  }
</style>
