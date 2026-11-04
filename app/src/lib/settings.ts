/**
 * User settings: the shape, the defaults, and durable storage.
 *
 * Kept free of Svelte so the merge/validation rules are unit-testable in plain
 * Node: a corrupted or partially-written settings blob must never be able to
 * blank the window, and that is exactly the kind of rule worth asserting.
 *
 * Storage is `localStorage`, not the backend. Settings are presentation only —
 * they never affect a diff result — so they do not belong in Rust state, and a
 * webview-local store keeps a stale schema from being able to break startup.
 */

import type { IntensityName, SchemeName } from "./theme";
import { isLocale, type Locale } from "./i18n";

export type ThemeMode = "system" | "light" | "dark";

/** How much of the change colour is applied to intra-line pills. */
export interface Settings {
  /** Chrome appearance. */
  theme: ThemeMode;
  /** Accent colour, any `#rrggbb`. */
  accent: string;
  /** Delete/insert hue pair. */
  scheme: SchemeName;
  /** Tint strength. */
  intensity: IntensityName;
  /** Code font size in px; row height is derived from it. */
  fontSize: number;
  /** Show the line-number gutter. */
  lineNumbers: boolean;
  /**
   * Wrap long lines instead of scrolling horizontally.
   *
   * Off by default: a diff is read by comparing columns on the left and right, and
   * wrapping breaks that relationship. It is the right choice for prose, narrow
   * windows and minified files, so it is a toggle rather than a fixed rule.
   */
  wrapLines: boolean;
  /** Show the minimap strip. */
  minimap: boolean;
  /** Keep long unchanged runs collapsed when a diff opens. */
  autoFold: boolean;
  /** Mark unchanged runs longer than this instead of showing them. */
  foldThreshold: number;
  /** Draw the character-level highlight inside changed lines. */
  intraLine: boolean;
  /**
   * Colour code by language.
   *
   * Its own switch rather than implied by other settings: a reader comparing two
   * paragraphs does not want their prose painted, and a reader who wants maximum
   * contrast on the change tints should be able to turn colour off entirely.
   */
  syntaxHighlight: boolean;
  /** Collapse identical runs when comparing, ignoring leading/trailing space. */
  ignoreWhitespace: boolean;
  /** Ignore case when comparing lines. */
  ignoreCase: boolean;
  /** Draw the 3px change stripe on the leading edge of changed rows. */
  changeEdge: boolean;
  /** Line height as a multiple of font size. */
  lineHeight: number;
  /**
   * Left pane share of the split view, 0.15-0.85.
   *
   * Stored as a fraction rather than pixels so the split survives a window
   * resize: an absolute px width would leave the panes lopsided after the window
   * grows, which is exactly when the user is least willing to re-drag.
   */
  splitRatio: number;
  /**
   * Interface language.
   *
   * `null` means "follow the OS", which is the default and is deliberately distinct
   * from storing the detected locale: a user who moves their system to another
   * language expects the app to follow, and only an explicit choice should pin it.
   */
  locale: Locale | null;
  /**
   * How long comparisons are kept on disk.
   *
   * `days: 0` and `keep: 0` each disable their rule, which is how "never clean up"
   * is expressed without a second boolean.
   */
  historyDays: number;
  historyKeep: number;
  /** Record every comparison to disk. Off means nothing is written at all. */
  historyEnabled: boolean;
}

/**
 * Defaults must reproduce the original design exactly: the shipped look is what
 * the visual spec locks down, so a fresh install has to be indistinguishable
 * from the pre-settings build.
 */
export const DEFAULTS: Settings = {
  theme: "system",
  accent: "#0a84ff",
  scheme: "classic",
  intensity: "normal",
  fontSize: 12,
  lineNumbers: true,
  wrapLines: false,
  minimap: true,
  autoFold: true,
  foldThreshold: 10,
  intraLine: true,
  syntaxHighlight: true,
  ignoreWhitespace: false,
  ignoreCase: false,
  changeEdge: true,
  /**
   * Exact, not `20 / 12`: a repeating decimal cannot survive a round trip through
   * the 0.05 step, so the stored default would come back as 1.65 and look like a
   * user modification. 12px x 1.65 rounds to the shipped 20px row height.
   */
  lineHeight: 1.65,
  /** Centred by default: the two panes start with equal width. */
  splitRatio: 0.5,
  /** Follow the OS on first launch; an explicit choice is stored instead. */
  locale: null,
  /**
   * A week and a hundred entries: enough to answer "what was I comparing
   * yesterday", short enough that pasted client data does not pile up on disk.
   */
  historyEnabled: true,
  historyDays: 7,
  historyKeep: 100,
};

/** Bounds are part of the contract: the UI sliders clamp to the same range. */
export const LIMITS = {
  fontSize: { min: 10, max: 18, step: 1 },
  foldThreshold: { min: 4, max: 60, step: 2 },
  lineHeight: { min: 1.3, max: 2.0, step: 0.05 },
  splitRatio: { min: 0.15, max: 0.85, step: 0.001 },
  historyDays: { min: 0, max: 365, step: 1 },
  historyKeep: { min: 0, max: 1000, step: 10 },
} as const;

const STORAGE_KEY = "litediff.settings.v1";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** Round to the slider's step so a hand-edited value cannot desync the UI. */
function snap(n: number, step: number): number {
  const snapped = Math.round(n / step) * step;
  // Round away binary float noise: 1.3 + 0.05 * 3 is not 1.45 in IEEE-754.
  return Number(snapped.toFixed(4));
}

/**
 * Merge an untrusted object over the defaults.
 *
 * Every field is validated individually and falls back independently, so one bad
 * value (say a `fontSize` stored as a string) does not discard the user's other
 * preferences. Unknown keys are dropped, which makes removing a setting safe.
 */
export function normalizeSettings(raw: unknown): Settings {
  const input = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const out: Settings = { ...DEFAULTS };

  const bool = (key: keyof Settings) => {
    const v = input[key];
    if (typeof v === "boolean") (out[key] as boolean) = v;
  };
  const num = (key: keyof Settings, min: number, max: number, step: number) => {
    const v = input[key];
    if (typeof v === "number" && Number.isFinite(v)) {
      (out[key] as number) = snap(clamp(v, min, max), step);
    }
  };

  if (input.theme === "system" || input.theme === "light" || input.theme === "dark") {
    out.theme = input.theme;
  }
  if (input.scheme === "classic" || input.scheme === "colorblind" || input.scheme === "muted") {
    out.scheme = input.scheme;
  }
  if (
    input.intensity === "soft" ||
    input.intensity === "normal" ||
    input.intensity === "strong"
  ) {
    out.intensity = input.intensity;
  }
  if (typeof input.accent === "string" && /^#[\da-f]{6}$/i.test(input.accent.trim())) {
    out.accent = input.accent.trim().toLowerCase();
  }

  num("fontSize", LIMITS.fontSize.min, LIMITS.fontSize.max, LIMITS.fontSize.step);
  num("foldThreshold", LIMITS.foldThreshold.min, LIMITS.foldThreshold.max, LIMITS.foldThreshold.step);
  num("lineHeight", LIMITS.lineHeight.min, LIMITS.lineHeight.max, LIMITS.lineHeight.step);
  num("splitRatio", LIMITS.splitRatio.min, LIMITS.splitRatio.max, LIMITS.splitRatio.step);
  num("historyDays", LIMITS.historyDays.min, LIMITS.historyDays.max, LIMITS.historyDays.step);
  num("historyKeep", LIMITS.historyKeep.min, LIMITS.historyKeep.max, LIMITS.historyKeep.step);
  bool("historyEnabled");
  bool("lineNumbers");
  bool("wrapLines");
  bool("minimap");
  bool("autoFold");
  bool("intraLine");
  bool("syntaxHighlight");
  bool("ignoreWhitespace");
  bool("ignoreCase");
  bool("changeEdge");

  /*
   * Language: an explicit choice is a Locale; `null` means "follow the OS".
   *
   * Anything else — a tag this build dropped, a hand-edited value — normalises to
   * `null` rather than to a specific locale, so the app falls back to the OS
   * language instead of pinning one the user never chose.
   */
  if (input.locale === null) {
    out.locale = null;
  } else if (isLocale(input.locale)) {
    out.locale = input.locale;
  }

  return out;
}

/** True when anything differs from a fresh install. */
export function isModified(s: Settings): boolean {
  return (Object.keys(DEFAULTS) as Array<keyof Settings>).some((k) => s[k] !== DEFAULTS[k]);
}

/**
 * Row height derived from font size and line height.
 *
 * Rounded to whole pixels on purpose: the virtual scroller divides scroll offsets
 * by this number, and a fractional row height makes `scrollTop / rowHeight`
 * land between rows, which shows up as a one-pixel jump on every scroll event.
 */
export function rowHeightFor(s: Settings): number {
  return Math.max(12, Math.round(s.fontSize * s.lineHeight));
}

export function loadSettings(storage: Storage | undefined = globalThis.localStorage): Settings {
  if (!storage) return { ...DEFAULTS };
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return normalizeSettings(JSON.parse(raw));
  } catch {
    // A corrupt blob (or a webview with storage disabled) must not brick startup.
    return { ...DEFAULTS };
  }
}

export function saveSettings(
  s: Settings,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Quota or private mode: settings simply do not persist, which is survivable.
  }
}

export const SETTINGS_STORAGE_KEY = STORAGE_KEY;
