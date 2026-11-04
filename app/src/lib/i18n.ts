/**
 * Translation catalogue and lookup.
 *
 * ## Why a hand-rolled i18n instead of a library
 *
 * The app has ~190 strings and no pluralization or date formatting needs beyond a
 * handful of numbers. `svelte-i18n` and `typesafe-i18n` both add a compiler step,
 * a store layer and (in the second case) generated files to keep in sync; that is
 * more machinery than the problem has. What is needed is: a typed key set, a
 * lookup with a fallback, and interpolation for the few strings that embed a count
 * or a shortcut. That is what this file does, in ~120 lines with no dependency.
 *
 * The type safety is the important part: `MessageKey` is derived from the English
 * catalogue, so every other locale is checked at compile time against it and a
 * missing or misspelled key fails `svelte-check` rather than rendering `undefined`
 * in the window.
 */

import { en } from "./locales/en";
import { zhHans } from "./locales/zh-Hans";
import { zhHant } from "./locales/zh-Hant";
import { ja } from "./locales/ja";
import { es } from "./locales/es";
import { de } from "./locales/de";
import { fr } from "./locales/fr";

/**
 * Supported locales.
 *
 * Ordered by expected audience size for this tool: Simplified Chinese (the
 * project's own language), then English, then the other CJK and European markets.
 * The order is what the settings list uses.
 */
export const LOCALES = ["zh-Hans", "en", "zh-Hant", "ja", "es", "de", "fr"] as const;

export type Locale = (typeof LOCALES)[number];

/** Fallback when nothing else matches, including for a stale stored preference. */
export const FALLBACK_LOCALE: Locale = "en";

/**
 * The key set, derived from the English catalogue.
 *
 * English is the source of truth for *which keys exist*; every other locale is
 * typed against it, so an omission is a compile error instead of a blank label.
 */
export type MessageKey = keyof typeof en;

/** One locale's strings. Every key is required. */
export type Catalogue = Record<MessageKey, string>;

/** Native name and English name, for the language picker. */
export interface LocaleMeta {
  readonly id: Locale;
  /** Shown in the picker, in the language itself. */
  readonly native: string;
  /** Shown as a secondary line, in the current UI language. */
  readonly english: string;
}

export const LOCALE_META: Record<Locale, LocaleMeta> = {
  "zh-Hans": { id: "zh-Hans", native: "简体中文", english: "Chinese (Simplified)" },
  en: { id: "en", native: "English", english: "English" },
  "zh-Hant": { id: "zh-Hant", native: "繁體中文", english: "Chinese (Traditional)" },
  ja: { id: "ja", native: "日本語", english: "Japanese" },
  es: { id: "es", native: "Español", english: "Spanish" },
  de: { id: "de", native: "Deutsch", english: "German" },
  fr: { id: "fr", native: "Français", english: "French" },
};

/** All catalogues, keyed by locale. */
export const CATALOGUES: Record<Locale, Catalogue> = {
  "zh-Hans": zhHans,
  en,
  "zh-Hant": zhHant,
  ja,
  es,
  de,
  fr,
};

/**
 * Values substituted into a message.
 *
 * Numbers are allowed because several strings count something ("{n} 行"); the
 * lookup stringifies them in the locale's own number format only for grouping,
 * which every supported locale writes the same way for small counts.
 */
export type Vars = Record<string, string | number>;

/**
 * Substitute `{name}` placeholders.
 *
 * Deliberately not `String.replace` with a function per key: a single pass over
 * the template means a substituted value can never itself be scanned for
 * placeholders (a filename containing `{n}` must stay literal).
 */
function interpolate(template: string, vars?: Vars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * Translate a key.
 *
 * Falls back through: requested locale → English → the key itself. The last step
 * matters: showing `toolbar.settings` is ugly but it makes a missing translation
 * obvious in a screenshot, whereas an empty string looks like a layout bug.
 */
export function translate(locale: Locale, key: MessageKey, vars?: Vars): string {
  const catalogue = CATALOGUES[locale] ?? CATALOGUES[FALLBACK_LOCALE];
  const value = catalogue[key] ?? CATALOGUES[FALLBACK_LOCALE][key] ?? key;
  return interpolate(value, vars);
}

/**
 * True when `value` is a locale this build ships.
 *
 * Used when loading the stored preference: a value written by an older (or newer)
 * build must fall back rather than breaking the UI.
 */
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

/**
 * Best match for a BCP-47 tag from the OS.
 *
 * Handles the two shapes that actually appear: an exact tag (`zh-Hant-TW`) and a
 * bare language (`de-AT`). A bare `zh` resolves to Simplified, matching the
 * majority of Chinese-speaking users and the project's own default.
 */
export function matchLocale(tag: string | undefined | null): Locale | null {
  if (!tag) return null;
  const lower = tag.toLowerCase();

  // Exact (case-insensitive) match first: "zh-hant" must not be caught by "zh".
  for (const locale of LOCALES) {
    if (locale.toLowerCase() === lower) return locale;
  }
  // Region/script subtags: "zh-Hant-TW" → "zh-Hant", "de-AT" → "de".
  const parts = lower.split("-");
  for (let take = parts.length - 1; take >= 1; take--) {
    const candidate = parts.slice(0, take).join("-");
    for (const locale of LOCALES) {
      if (locale.toLowerCase() === candidate) return locale;
    }
  }
  // Bare language.
  const base = parts[0];
  if (base === "zh") {
    // Traditional is written zh-Hant/zh-TW/zh-HK; everything else is Simplified.
    const traditional = parts.some((p) => ["hant", "tw", "hk", "mo"].includes(p));
    return traditional ? "zh-Hant" : "zh-Hans";
  }
  for (const locale of LOCALES) {
    if (locale.toLowerCase() === base) return locale;
  }
  return null;
}

/**
 * The locale to use on first launch.
 *
 * `navigator.languages` is preferred over `navigator.language`: it is the user's
 * ordered preference list, and a machine set to `[fr, en]` should get French even
 * though `navigator.language` reports the first entry anyway. Falls back to English
 * rather than to the project's own language, because a user whose system language
 * this app does not ship should still get something they can read.
 */
export function detectLocale(
  languages: readonly string[] | undefined = typeof navigator === "undefined"
    ? undefined
    : navigator.languages,
): Locale {
  for (const tag of languages ?? []) {
    const match = matchLocale(tag);
    if (match) return match;
  }
  return FALLBACK_LOCALE;
}
