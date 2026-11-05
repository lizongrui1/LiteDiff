<script lang="ts">
  /**
   * Settings sheet.
   *
   * A side sheet rather than a modal dialog: the diff stays visible beside it, so
   * every change can be judged against real content instead of a preview swatch.
   * That is the whole reason colour settings are worth exposing — a tint that
   * looks right on a white card looks wrong over real code.
   *
   * Controls are plain native inputs styled to AppKit proportions. No custom
   * dropdown or switch implementation: the platform already renders those
   * correctly, including keyboard and screen-reader behaviour.
   */

  import { LIMITS, isModified, rowHeightFor, type Settings } from "../lib/settings";
  import type { IntensityName, SchemeName } from "../lib/theme";
  import { t } from "../lib/i18nStore";
  import type { MessageKey } from "../lib/i18n";
  import { LOCALES, LOCALE_META, isLocale, type Locale } from "../lib/i18n";

  interface Props {
    settings: Settings;
    onPatch: (patch: Partial<Settings>) => void;
    onReset: () => void;
    onClose: () => void;
  }

  let { settings, onPatch, onReset, onClose }: Props = $props();

  const rowHeight = $derived(rowHeightFor(settings));

  /** The stored choice, resolved for the <select>: `null` renders as "auto". */
  const locale = $derived(settings.locale);

  /** `"auto"` maps back to `null` (follow the OS); anything else must be a Locale. */
  function asLocaleChoice(value: string): Locale | null {
    if (value === "auto") return null;
    return isLocale(value) ? value : null;
  }

  /**
   * Percentage of a range input that should be painted with the accent colour.
   *
   * The custom track is a CSS gradient, and CSS cannot read an input's value, so
   * each slider gets `--fill` as an inline custom property. Computed here rather
   * than per-element in the markup so the four sliders cannot drift apart in how
   * they round.
   */
  function fillPercent(value: number, min: number, max: number): string {
    if (max <= min) return "0%";
    const ratio = Math.min(1, Math.max(0, (value - min) / (max - min)));
    return `${(ratio * 100).toFixed(3)}%`;
  }

  /*
   * These tables hold message *keys*, not text.
   *
   * An earlier version stored the finished strings, which meant the labels were
   * frozen at module evaluation: switching language left the appearance section in
   * the old language until a reload. Storing keys and resolving them through `$t`
   * in the template makes the whole panel follow the language store.
   */
  const SCHEMES: SchemeName[] = ["classic", "colorblind", "muted"];

  const INTENSITY_KEYS: Record<IntensityName, MessageKey> = {
    soft: "settings.intensitySoft",
    normal: "settings.intensityNormal",
    strong: "settings.intensityStrong",
  };

  const ACCENTS: { value: string; key: MessageKey }[] = [
    { value: "#0a84ff", key: "accent.systemBlue" },
    { value: "#5e5ce6", key: "accent.indigo" },
    { value: "#30b0c7", key: "accent.teal" },
    { value: "#ff9500", key: "accent.amber" },
    { value: "#ff375f", key: "accent.rose" },
    { value: "#8e8e93", key: "accent.graphite" },
  ];

  /** Scheme name/hint keys, resolved in the template. */
  const SCHEME_KEYS: Record<SchemeName, { name: MessageKey; hint: MessageKey }> = {
    classic: { name: "settings.schemeClassic", hint: "settings.schemeClassicHint" },
    colorblind: { name: "settings.schemeColorblind", hint: "settings.schemeColorblindHint" },
    muted: { name: "settings.schemeMuted", hint: "settings.schemeMutedHint" },
  };

  function onKey(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.stopPropagation();
      onClose();
    }
  }
</script>

<svelte:window onkeydown={onKey} />

<aside class="sheet" aria-label={$t("settings.title")}>
  <header class="head">
    <h2>{$t("settings.title")}</h2>
    <button class="close" onclick={onClose} title={$t("settings.closeTitle")} aria-label={$t("settings.close")}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        <path
          d="m4.5 4.5 7 7m0-7-7 7"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
          stroke-linecap="round"
        />
      </svg>
    </button>
  </header>

  <div class="scroll">
    <!-- ── appearance ─────────────────────────────────────────────── -->
    <section>
      <h3>{$t("settings.section.appearance")}</h3>

      <!--
        Theme: three icon segments, with the name as a tooltip rather than a
        label inside the button.

        Written as text, the three segments needed 214px in French ("Suivre le
        système" / "Sombre" / "Clair") and 180px in German, which left the "Theme"
        label squeezed against the panel edge and in French pushed the whole sheet
        past its width. The icons are iconography the user already reads from the
        toolbar's theme cycle button, and a tooltip still names each one.
      -->
      <div class="row">
        <span class="row-label">{$t("settings.theme")}</span>
        <div class="field">
          <div class="segmented" role="radiogroup" aria-label={$t("settings.theme")}>
            {#each [["system", "theme.system"], ["light", "theme.light"], ["dark", "theme.dark"]] as const as [value, text] (value)}
              <button
                class="seg icon"
                class:on={settings.theme === value}
                role="radio"
                aria-checked={settings.theme === value}
                aria-label={$t(text)}
                title={$t(text)}
                onclick={() => onPatch({ theme: value })}
              >
                {#if value === "system"}
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <circle cx="8" cy="8" r="5.4" fill="none" stroke="currentColor" stroke-width="1.3" />
                    <path d="M8 2.6a5.4 5.4 0 0 1 0 10.8z" fill="currentColor" />
                  </svg>
                {:else if value === "light"}
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <circle cx="8" cy="8" r="3.1" fill="none" stroke="currentColor" stroke-width="1.3" />
                    <path
                      d="M8 1.4v1.5M8 13.1v1.5M1.4 8h1.5M13.1 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linecap="round"
                    />
                  </svg>
                {:else}
                  <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
                    <path
                      d="M13 9.6A5.6 5.6 0 0 1 6.4 3a5.6 5.6 0 1 0 6.6 6.6z"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="1.3"
                      stroke-linejoin="round"
                    />
                  </svg>
                {/if}
              </button>
            {/each}
          </div>
        </div>
      </div>

      <div class="row">
        <span class="row-label">{$t("settings.accent")}</span>
        <div class="field swatches">
          {#each ACCENTS as accent (accent.value)}
            <button
              class="swatch"
              class:on={settings.accent === accent.value}
              style:--swatch={accent.value}
              title={$t(accent.key)}
              aria-label={$t(accent.key)}
              aria-pressed={settings.accent === accent.value}
              onclick={() => onPatch({ accent: accent.value })}
            ></button>
          {/each}
          <!--
            The custom-colour well is the seventh swatch, with no word beside it.

            "Custom" is 43px in English but 79px in French ("Personnalisée") and
            66px in Spanish, which the seven swatches plus the well could not
            absorb — the row overflowed by up to 17px. A colour well labelled by
            its own tooltip says the same thing in every language.
          -->
          <label class="custom-color" title={$t("settings.accentCustom")}>
            <input
              type="color"
              value={settings.accent}
              aria-label={$t("settings.accentCustom")}
              oninput={(e) => onPatch({ accent: e.currentTarget.value })}
            />
          </label>
        </div>
      </div>
    </section>

    <!-- ── change colours ─────────────────────────────────────────── -->
    <section>
      <h3>{$t("settings.section.colors")}</h3>
      <!--
        The colour-scheme options get the full panel width, not the right-hand
        column of a label/control row.

        Each option carries a one-sentence explanation, and that sentence is the
        part that matters — "blue / amber" means nothing without "distinguishable
        with red-green colour blindness". In a 165px control column the English,
        Spanish and German hints either ran off the edge or forced the label column
        to shrink until "Color scheme" wrapped onto two lines, which then dragged
        the whole panel into horizontal overflow.

        Stacking the label above the group gives the hints the width they need and
        leaves the row structure intact in every language.
      -->
      <div class="block">
        <span class="row-label">{$t("settings.scheme")}</span>
        <div class="radios">
          {#each SCHEMES as value (value)}
            <label class="radio" class:on={settings.scheme === value}>
              <input
                type="radio"
                name="scheme"
                value={value}
                checked={settings.scheme === value}
                onchange={() => onPatch({ scheme: value as SchemeName })}
              />
              <span class="radio-text">
                <span class="radio-name">{$t(SCHEME_KEYS[value].name)}</span>
                <span class="radio-hint">{$t(SCHEME_KEYS[value].hint)}</span>
              </span>
            </label>
          {/each}
        </div>
      </div>

      <div class="slider-row">
        <div class="slider-head">
          <label class="row-label" for="set-intensity">{$t("settings.intensity")}</label>
          <span class="value-pill">{$t(INTENSITY_KEYS[settings.intensity])}</span>
        </div>
        <input
          id="set-intensity"
          type="range"
          min="0"
          max="2"
          step="1"
          value={["soft", "normal", "strong"].indexOf(settings.intensity)}
          style:--fill={fillPercent(["soft", "normal", "strong"].indexOf(settings.intensity), 0, 2)}
          oninput={(e) =>
            onPatch({
              intensity: (["soft", "normal", "strong"] as const)[Number(e.currentTarget.value)],
            })}
        />
      </div>

      <label class="row">
        <span class="row-label">{$t("settings.edge")}</span>
        <div class="field">
          <input
            type="checkbox"
            checked={settings.changeEdge}
            onchange={(e) => onPatch({ changeEdge: e.currentTarget.checked })}
          />
        </div>
      </label>

      <label class="row">
        <span class="row-label">{$t("settings.intraLine")}</span>
        <div class="field">
          <input
            type="checkbox"
            checked={settings.intraLine}
            onchange={(e) => onPatch({ intraLine: e.currentTarget.checked })}
          />
        </div>
      </label>

      <!--
        Syntax highlighting lives under "comparison rules" rather than appearance:
        it is about what the reader can tell apart in the code, and it is the switch
        you reach for when the colour competes with the change tints.
      -->
      <label class="row">
        <span class="row-label">{$t("settings.syntaxHighlight")}</span>
        <div class="field">
          <input
            type="checkbox"
            checked={settings.syntaxHighlight}
            onchange={(e) => onPatch({ syntaxHighlight: e.currentTarget.checked })}
          />
        </div>
      </label>
    </section>

    <!-- ── typography ─────────────────────────────────────────────── -->
    <section>
      <h3>{$t("settings.section.type")}</h3>

      <div class="slider-row">
        <div class="slider-head">
          <label class="row-label" for="set-font">{$t("settings.fontSize")}</label>
          <span class="value-pill">{settings.fontSize}px</span>
        </div>
        <input
          id="set-font"
          type="range"
          min={LIMITS.fontSize.min}
          max={LIMITS.fontSize.max}
          step={LIMITS.fontSize.step}
          value={settings.fontSize}
          style:--fill={fillPercent(settings.fontSize, LIMITS.fontSize.min, LIMITS.fontSize.max)}
          oninput={(e) => onPatch({ fontSize: Number(e.currentTarget.value) })}
        />
      </div>

      <div class="slider-row">
        <div class="slider-head">
          <label class="row-label" for="set-lh">{$t("settings.lineHeight")}</label>
          <span class="value-pill">{rowHeight}px</span>
        </div>
        <input
          id="set-lh"
          type="range"
          min={LIMITS.lineHeight.min}
          max={LIMITS.lineHeight.max}
          step={LIMITS.lineHeight.step}
          value={settings.lineHeight}
          style:--fill={fillPercent(settings.lineHeight, LIMITS.lineHeight.min, LIMITS.lineHeight.max)}
          oninput={(e) => onPatch({ lineHeight: Number(e.currentTarget.value) })}
        />
      </div>
    </section>

    <!-- ── layout & reading ───────────────────────────────────────── -->
    <section>
      <h3>{$t("settings.section.reading")}</h3>

      <label class="row">
        <span class="row-label">{$t("settings.lineNumbers")}</span>
        <div class="field">
          <input
            type="checkbox"
            checked={settings.lineNumbers}
            onchange={(e) => onPatch({ lineNumbers: e.currentTarget.checked })}
          />
        </div>
      </label>

      <label class="row">
        <span class="row-label">{$t("settings.minimap")}</span>
        <div class="field">
          <input
            type="checkbox"
            checked={settings.minimap}
            onchange={(e) => onPatch({ minimap: e.currentTarget.checked })}
          />
        </div>
      </label>

      <label class="row">
        <span class="row-label">{$t("settings.autoFold")}</span>
        <div class="field">
          <input
            type="checkbox"
            checked={settings.autoFold}
            onchange={(e) => onPatch({ autoFold: e.currentTarget.checked })}
          />
        </div>
      </label>

      <div class="slider-row" class:disabled={!settings.autoFold}>
        <div class="slider-head">
          <label class="row-label" for="set-threshold">{$t("settings.foldThreshold")}</label>
          <span class="value-pill">{$t("edit.lines", { n: settings.foldThreshold })}</span>
        </div>
        <input
          id="set-threshold"
          type="range"
          min={LIMITS.foldThreshold.min}
          max={LIMITS.foldThreshold.max}
          step={LIMITS.foldThreshold.step}
          value={settings.foldThreshold}
          style:--fill={fillPercent(settings.foldThreshold, LIMITS.foldThreshold.min, LIMITS.foldThreshold.max)}
          oninput={(e) => onPatch({ foldThreshold: Number(e.currentTarget.value) })}
        />
      </div>

      <!--
        Split ratio lives here as well as on the divider itself. The drag handle
        is the fast path; this row is the discoverable one, and it is the only
        way to set an exact value with the keyboard's coarse steps.
      -->
      <div class="slider-row">
        <div class="slider-head">
          <label class="row-label" for="set-split">{$t("settings.splitRatio")}</label>
          <span class="value-pill">{Math.round(settings.splitRatio * 100)} : {100 - Math.round(settings.splitRatio * 100)}</span>
        </div>
        <input
          id="set-split"
          type="range"
          min={LIMITS.splitRatio.min}
          max={LIMITS.splitRatio.max}
          step={LIMITS.splitRatio.step}
          value={settings.splitRatio}
          style:--fill={fillPercent(settings.splitRatio, LIMITS.splitRatio.min, LIMITS.splitRatio.max)}
          oninput={(e) => onPatch({ splitRatio: Number(e.currentTarget.value) })}
        />
      </div>
    </section>

    <!-- ── comparison ─────────────────────────────────────────────── -->
    <section>
      <h3>{$t("settings.section.rules")}</h3>

      <label class="row">
        <span class="row-label">{$t("settings.ignoreWhitespace")}</span>
        <div class="field">
          <input
            type="checkbox"
            checked={settings.ignoreWhitespace}
            onchange={(e) => onPatch({ ignoreWhitespace: e.currentTarget.checked })}
          />
        </div>
      </label>

      <label class="row">
        <span class="row-label">{$t("settings.ignoreCase")}</span>
        <div class="field">
          <input
            type="checkbox"
            checked={settings.ignoreCase}
            onchange={(e) => onPatch({ ignoreCase: e.currentTarget.checked })}
          />
        </div>
      </label>
    </section>

    <!-- ── history ───────────────────────────────────────────────────── -->
    <section>
      <h3>{$t("settings.section.history")}</h3>

      <label class="row">
        <span class="row-label">{$t("settings.historyEnabled")}</span>
        <div class="field">
          <input
            type="checkbox"
            checked={settings.historyEnabled}
            onchange={(e) => onPatch({ historyEnabled: e.currentTarget.checked })}
          />
        </div>
      </label>

      <!--
        Retention as two numbers, not a dropdown of presets.

        "7 days" and "keep 100" are different questions — one bounds time, the other
        bounds disk — and a preset list would force them into a single choice. Zero
        disables each rule, which is stated in the hint rather than needing a second
        switch.
      -->
      <div class="row" class:disabled={!settings.historyEnabled}>
        <label class="row-label" for="set-history-days">{$t("settings.historyDays")}</label>
        <div class="field">
          <input
            id="set-history-days"
            type="number"
            min={LIMITS.historyDays.min}
            max={LIMITS.historyDays.max}
            step={LIMITS.historyDays.step}
            disabled={!settings.historyEnabled}
            value={settings.historyDays}
            onchange={(e) => onPatch({ historyDays: Number(e.currentTarget.value) })}
          />
          <span class="value">{$t("settings.historyDaysUnit")}</span>
        </div>
      </div>

      <div class="row" class:disabled={!settings.historyEnabled}>
        <label class="row-label" for="set-history-keep">{$t("settings.historyKeep")}</label>
        <div class="field">
          <input
            id="set-history-keep"
            type="number"
            min={LIMITS.historyKeep.min}
            max={LIMITS.historyKeep.max}
            step={LIMITS.historyKeep.step}
            disabled={!settings.historyEnabled}
            value={settings.historyKeep}
            onchange={(e) => onPatch({ historyKeep: Number(e.currentTarget.value) })}
          />
          <span class="value">{$t("settings.historyKeepUnit")}</span>
        </div>
      </div>

      <p class="hint">{$t("settings.historyHint")}</p>
    </section>

    <!-- ── language ──────────────────────────────────────────────────── -->
    <section>
      <h3>{$t("settings.section.language")}</h3>

      <!--
        A plain <select>, not a styled dropdown.

        Seven locales is past the point where a segmented control reads well, and
        the native popup is the one control macOS draws correctly in all of them —
        including the right font fallback for Japanese and both Chinese scripts.
        Rebuilding it would mean re-implementing that from scratch.
      -->
      <div class="row">
        <label class="row-label" for="set-locale">{$t("settings.language")}</label>
        <div class="select-shell">
          <select
            id="set-locale"
            class="select"
            value={locale === null ? "auto" : locale}
            onchange={(e) => onPatch({ locale: asLocaleChoice(e.currentTarget.value) })}
          >
            <option value="auto">{$t("settings.languageAuto")}</option>
            {#each LOCALES as code (code)}
              <option value={code}>{LOCALE_META[code].native}</option>
            {/each}
          </select>
          <svg class="select-chevron" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
            <path
              d="m3 4.5 3 3 3-3"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </div>
      </div>
    </section>

    <!--
      The "changes are saved automatically" caption lives at the end of the
      scrolled content, not in the 34px footer.
    -->
    <p class="foot-note">{$t("settings.note")}</p>
  </div>

  <footer class="foot">
    <button
      class="reset"
      disabled={!isModified(settings)}
      onclick={onReset}
    >
      {$t("settings.reset")}
    </button>
  </footer>
</aside>

<style>
  .sheet {
    /*
     * `min-width: 0` is load-bearing, not decoration.
     *
     * A flex item's automatic minimum size is its min-content width. The sheet
     * contains long single-line strings (the footer caption, the label of a
     * slider row), so that minimum exceeded the fixed 320px basis and the panel
     * grew with the language — 560px in French — pushing the diff and the toolbar
     * controls out of the window. Bounding it here makes the fixed basis win and
     * lets the inner rules clip instead.
     */
    flex: 0 0 320px;
    min-width: 0;
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
    height: 40px;
    padding: 0 10px 0 14px;
    border-bottom: 1px solid var(--c-border);
  }

  h2 {
    margin: 0;
    font-size: 13px;
    font-weight: 650;
    letter-spacing: -0.01em;
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

  /*
   * `overflow-x: hidden`, deliberately.
   *
   * Every way a row could exceed the panel width is now prevented at the source
   * (see `.row-label` / `.field`), but a 10px string in a language nobody has
   * tested is exactly the kind of thing that reappears. Hiding the axis means the
   * worst case is a clipped word in one row instead of a scrollbar that shifts
   * every section and makes the whole panel look broken.
   */
  .scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 5px 0 10px;
  }

  section {
    padding: 12px 12px 14px;
    border-bottom: 1px solid var(--c-border);
  }

  section:last-child {
    border-bottom: none;
  }

  h3 {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 9px;
    font-size: 10px;
    font-weight: 650;
    letter-spacing: 0.055em;
    text-transform: uppercase;
    color: var(--c-text-faint);
  }

  /* A single accent tick gives each section a quiet anchor without turning the
     sheet into a stack of cards. */
  h3::before {
    content: "";
    width: 3px;
    height: 9px;
    border-radius: 999px;
    background: var(--c-accent);
    opacity: 0.72;
  }

  /*
   * Label left, control right: the standard AppKit settings row.
   *
   * The two halves are allowed to shrink (`min-width: 0`) and the label wraps
   * onto a second line rather than pushing the control out of the panel. Before,
   * the label was `flex: 0 1 auto` with no `min-width` and the control column was
   * `flex: 0 0 auto`, so a long translation did not wrap — it widened the row,
   * which widened the scrolling box, which produced a horizontal scrollbar under
   * the whole sheet and made the following sections look misaligned.
   */
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 31px;
  }

  .row.disabled {
    opacity: 0.42;
  }

  label.row {
    margin: 0 -4px;
    padding: 0 4px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 100ms ease;
  }

  label.row:hover {
    background: var(--c-bg);
  }

  .row-label {
    flex: 1 1 auto;
    min-width: 0;
    font-size: 12px;
    line-height: 1.35;
    color: var(--c-text);
  }

  .field {
    flex: 0 1 auto;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  /*
   * Label above the control, full width.
   *
   * For controls that carry sentences — the colour-scheme options — a shared row
   * has no layout that works in all seven languages: the hints need the width, and
   * giving it to them starves the label.
   */
  .block {
    padding: 2px 0 4px;
  }

  .radios {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding-top: 4px;
  }

  /* Unit readout beside the compact number fields. */
  .value {
    flex: 0 0 auto;
    min-width: 22px;
    overflow: hidden;
    font-size: 11px;
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
    color: var(--c-text-muted);
  }

  /*
   * A slider gets its own block instead of sharing a 305px row with its label.
   * The full-width track is both easier to hit and visually quieter than a
   * 56–96px stub squeezed between two columns of text.
   */
  .slider-row {
    padding: 8px 0 7px;
  }

  .slider-row.disabled {
    opacity: 0.42;
  }

  .slider-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
  }

  .value-pill {
    flex: 0 0 auto;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 52px;
    height: 22px;
    padding: 0 8px;
    border: 1px solid var(--c-border);
    border-radius: 6px;
    background: var(--c-bg);
    color: var(--c-text-muted);
    font-family: var(--font-mono);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  /* --- segmented control ------------------------------------------------ */
  .segmented {
    display: inline-flex;
    padding: 2px;
    border: 1px solid var(--c-border);
    border-radius: 8px;
    background: var(--c-bg-sunken);
  }

  .seg {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: 22px;
    padding: 0 7px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--c-text-muted);
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    white-space: nowrap;
  }

  /*
   * Icon segments: a fixed 26px square.
   *
   * Equal widths matter more here than with text — three glyphs of slightly
   * different optical weight at different paddings read as three separate buttons
   * rather than one three-way switch.
   */
  .seg.icon {
    width: 26px;
    padding: 0;
  }

  .seg.icon:hover:not(.on) {
    color: var(--c-text);
  }

  .seg.on {
    background: var(--c-bg);
    color: var(--c-text);
    box-shadow:
      0 0 0 1px var(--c-border),
      0 1px 2px rgba(0, 0, 0, 0.1);
  }

  /* --- accent swatches -------------------------------------------------- */
  .swatches {
    gap: 4px;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .swatch {
    width: 17px;
    height: 17px;
    padding: 0;
    border: 2px solid var(--c-bg-elevated);
    border-radius: 50%;
    background: var(--swatch);
    cursor: pointer;
    box-shadow: 0 0 0 1px var(--c-border-strong);
    transition:
      transform 100ms ease,
      box-shadow 100ms ease;
  }

  .swatch:hover {
    transform: scale(1.08);
  }

  /* Selected swatch gets a ring made of two shadows, so it needs no layout. */
  .swatch.on {
    box-shadow:
      0 0 0 1px var(--c-bg-elevated),
      0 0 0 2.5px var(--c-accent);
  }

  .custom-color {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    font-size: 11px;
    color: var(--c-text-muted);
    cursor: pointer;
  }

  /* A colour input is a control, not a swatch: keep it small and flat. */
  .custom-color input {
    width: 16px;
    height: 16px;
    padding: 0;
    border: 1px solid var(--c-border-strong);
    border-radius: 4px;
    background: none;
    cursor: pointer;
  }

  .custom-color input::-webkit-color-swatch-wrapper {
    padding: 0;
  }

  .custom-color input::-webkit-color-swatch {
    border: none;
    border-radius: 3px;
  }

  /* --- radios ---------------------------------------------------------- */
  .radio {
    display: flex;
    align-items: flex-start;
    gap: 9px;
    padding: 7px 8px;
    border: 1px solid transparent;
    border-radius: 8px;
    cursor: pointer;
    transition:
      background 100ms ease,
      border-color 100ms ease;
  }

  .radio:hover {
    background: var(--c-bg);
  }

  .radio.on {
    border-color: var(--c-border);
    background: var(--c-selection);
  }

  .radio input {
    position: relative;
    flex: 0 0 auto;
    width: 14px;
    height: 14px;
    margin: 1px 0 0;
    appearance: none;
    -webkit-appearance: none;
    border: 1.5px solid var(--c-border-strong);
    border-radius: 50%;
    background: var(--c-bg);
    cursor: pointer;
  }

  .radio input:checked {
    border-color: var(--c-accent);
  }

  .radio input:checked::after {
    content: "";
    position: absolute;
    inset: 2.5px;
    border-radius: 50%;
    background: var(--c-accent);
  }

  .radio input:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--c-selection);
  }

  .radio-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .radio-name {
    font-size: 12px;
    color: var(--c-text);
  }

  .radio-hint {
    font-size: 10px;
    line-height: 1.4;
    color: var(--c-text-faint);
  }

  /* --- switches -------------------------------------------------------- */
  /*
   * Checkboxes become compact switches. The native blue square is the one
   * platform control that visibly ignores the app accent and reads much heavier
   * than the hairlines around it.
   */
  .row input[type="checkbox"] {
    position: relative;
    flex: 0 0 auto;
    width: 30px;
    height: 18px;
    margin: 0;
    appearance: none;
    -webkit-appearance: none;
    border: 1px solid var(--c-border-strong);
    border-radius: 999px;
    background: var(--c-bg-sunken);
    cursor: pointer;
    transition:
      background 120ms ease,
      border-color 120ms ease;
  }

  .row input[type="checkbox"]::after {
    content: "";
    position: absolute;
    top: 2px;
    left: 2px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--c-text-faint);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.18);
    transition:
      transform 120ms ease,
      background 120ms ease;
  }

  .row input[type="checkbox"]:checked {
    border-color: var(--c-accent);
    background: var(--c-accent);
  }

  .row input[type="checkbox"]:checked::after {
    transform: translateX(12px);
    background: #fff;
  }

  .row input[type="checkbox"]:focus-visible {
    outline: none;
    box-shadow: 0 0 0 3px var(--c-selection);
  }

  /* --- range ----------------------------------------------------------- */
  input[type="range"] {
    appearance: none;
    -webkit-appearance: none;
    display: block;
    width: 100%;
    height: 18px;
    margin: 0;
    background: transparent;
    cursor: pointer;
  }

  /*
   * Pseudo-elements are where Svelte's scoping hurts.
   *
   * The compiler appends its scope hash to simple selectors, and a hashed
   * `input.svelte-xyz::-webkit-slider-thumb` does not match — the pseudo-element
   * form has to stay attached to an unscoped `input`. So these rules go through
   * `:global`, anchored on `.sheet` so nothing outside this panel is affected.
   */
  :global(.sheet input[type="range"])::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 999px;
    background: linear-gradient(
      to right,
      var(--c-accent) 0 var(--fill, 50%),
      var(--c-border-strong) var(--fill, 50%) 100%
    );
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.08);
  }

  :global(.sheet input[type="range"])::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 14px;
    /* Centres a 14px thumb on a 4px track: (14 - 4) / 2. */
    margin-top: -5px;
    border-radius: 50%;
    border: 2px solid var(--c-bg-elevated);
    background: var(--c-accent);
    box-shadow:
      0 0 0 1px var(--c-border-strong),
      0 2px 4px rgba(0, 0, 0, 0.2);
    transition:
      transform 100ms ease,
      box-shadow 100ms ease;
  }

  :global(.sheet input[type="range"]:hover)::-webkit-slider-thumb {
    transform: scale(1.08);
  }

  :global(.sheet input[type="range"]:focus-visible)::-webkit-slider-thumb {
    transform: scale(1.08);
    box-shadow:
      0 0 0 3px var(--c-selection),
      0 0 0 1px var(--c-accent),
      0 2px 4px rgba(0, 0, 0, 0.2);
  }

  input[type="range"]:disabled {
    cursor: default;
    opacity: 0.4;
  }

  /* --- range: Firefox -------------------------------------------------- */
  :global(.sheet input[type="range"])::-moz-range-track {
    height: 4px;
    border-radius: 999px;
    background: var(--c-border-strong);
  }

  :global(.sheet input[type="range"])::-moz-range-progress {
    height: 4px;
    border-radius: 999px;
    background: var(--c-accent);
  }

  :global(.sheet input[type="range"])::-moz-range-thumb {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid var(--c-bg-elevated);
    background: var(--c-accent);
    box-shadow:
      0 0 0 1px var(--c-border-strong),
      0 2px 4px rgba(0, 0, 0, 0.2);
  }

  /* --- footer ---------------------------------------------------------- */
  .foot {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 42px;
    padding: 0 12px;
    border-top: 1px solid var(--c-border);
    background: var(--c-bg-sunken);
    /*
     * The caption below is a full sentence and cannot be allowed to define the
     * sheet's width.
     *
     * As a flex item with `nowrap` its min-content width is the whole sentence —
     * 356px in French — and because the sheet is a flex item inside the app
     * layout, that minimum was propagating up and widening the panel from 320px to
     * 560px, which is what pushed the toolbar's controls out of the window.
     * `min-width: 0` on the flex item stops the propagation; the ellipsis rule
     * further down then clips it in place.
     */
    min-width: 0;
  }

  /*
   * `nowrap` and a capped width.
   *
   * "Rétablir les valeurs par défaut" is 198px and "Tabelle zurücksetzen" 152px;
   * with no constraint the button either wrapped onto two lines inside a 34px
   * footer (clipped) or squeezed the caption into nothing. It shrinks to its
   * longest word instead, which keeps the footer one line in every language.
   */
  .reset {
    flex: 1 1 auto;
    min-width: 0;
    height: 28px;
    padding: 0 11px;
    border: 1px solid var(--c-border);
    border-radius: 7px;
    background: var(--c-bg);
    color: var(--c-text);
    font-family: inherit;
    font-size: 11.5px;
    font-weight: 560;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    transition:
      background 100ms ease,
      border-color 100ms ease;
  }

  .reset:hover:not(:disabled) {
    border-color: var(--c-border-strong);
    background: var(--c-bg-elevated);
  }

  .reset:disabled {
    opacity: 0.4;
    cursor: default;
  }

  /*
   * Caption under the last section.
   *
   * It has a whole row to itself, so it wraps instead of being truncated: the
   * sentence is 356px in French and 300px in German, which no 320px footer could
   * show next to a button without either wrapping under the panel's bottom edge or
   * losing half its characters.
   */
  .foot-note {
    margin: 0;
    padding: 4px 12px 8px;
    font-size: 10px;
    line-height: 1.5;
    color: var(--c-text-faint);
  }

  /*
   * Multiline explanatory text inside a section.
   *
   * Deliberately not `.note`: that one is pinned right in the 34px footer with no
   * wrapping, which would make a two-sentence hint one clipped line.
   */
  .hint {
    margin: 2px 0 4px;
    font-size: 10px;
    line-height: 1.5;
    color: var(--c-text-faint);
  }

  /* --- numeric and popup inputs ---------------------------------------- */
  /*
   * Number and select controls share one quiet field surface: a 28px box, a
   * hairline that strengthens on hover, and an accent wash only while focused.
   * Native spinners and the native select arrow are hidden because both read as
   * unstyled platform chrome against the rest of the editor.
   */
  input[type="number"],
  .select {
    height: 28px;
    border: 1px solid var(--c-border);
    border-radius: 7px;
    background: var(--c-bg);
    color: var(--c-text);
    font-family: var(--font-mono);
    font-size: 11.5px;
    font-variant-numeric: tabular-nums;
    transition:
      border-color 100ms ease,
      box-shadow 100ms ease,
      background 100ms ease;
  }

  input[type="number"]:hover,
  .select:hover {
    border-color: var(--c-border-strong);
  }

  input[type="number"]:focus-visible,
  .select:focus-visible {
    outline: none;
    border-color: var(--c-accent);
    box-shadow: 0 0 0 3px var(--c-selection);
  }

  input[type="number"] {
    width: 66px;
    padding: 0 8px;
    text-align: right;
    appearance: textfield;
    -moz-appearance: textfield;
  }

  input[type="number"]::-webkit-inner-spin-button,
  input[type="number"]::-webkit-outer-spin-button {
    margin: 0;
    appearance: none;
    -webkit-appearance: none;
  }

  .select-shell {
    position: relative;
    display: inline-flex;
    align-items: center;
    width: 148px;
  }

  .select {
    width: 100%;
    max-width: 148px;
    padding: 0 27px 0 9px;
    appearance: none;
    -webkit-appearance: none;
    cursor: pointer;
  }

  .select-chevron {
    position: absolute;
    right: 9px;
    color: var(--c-text-faint);
    pointer-events: none;
  }

  input[type="number"]:disabled,
  .select:disabled {
    opacity: 0.45;
    cursor: default;
  }
</style>
