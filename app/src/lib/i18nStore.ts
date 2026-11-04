/**
 * Reactive translation binding.
 *
 * Components call `t(...)` in markup and get re-rendered when the language
 * changes. The alternative — passing a `locale` prop through every component —
 * would put a presentation concern into eight component signatures and make
 * `{t("toolbar.new")}` impossible to write without threading it first.
 *
 * A module-level writable store is the smallest thing that works: one value, one
 * subscriber set, no provider tree.
 */

import { derived, writable } from "svelte/store";
import { detectLocale, translate, type Locale, type MessageKey, type Vars } from "./i18n";

/**
 * The active locale.
 *
 * Initialised from the OS so the first paint is already correct; `App` overwrites
 * it once settings load (an explicit choice beats detection) and on every change
 * from the settings sheet.
 */
export const locale = writable<Locale>(detectLocale());

/**
 * Translating function bound to the current locale.
 *
 * Typed as `MessageKey` rather than `string`, so a typo is a compile error in the
 * template instead of a rendered key name.
 */
export const t = derived(locale, (current) => {
  return (key: MessageKey, vars?: Vars): string => translate(current, key, vars);
});

/**
 * Set the locale imperatively.
 *
 * Thin wrapper so callers do not import `writable`'s `set` and so the intent reads
 * as "change the language" at the call site.
 */
export function setLocale(next: Locale): void {
  locale.set(next);
  /*
   * Keep `<html lang>` in step.
   *
   * It is not decoration: screen readers pick their pronunciation from it, and the
   * browser uses it to choose font fallbacks — which is what makes Japanese and
   * both Chinese variants render with the right glyph shapes instead of loaned
   * ones from the wrong region.
   */
  if (typeof document !== "undefined") {
    document.documentElement.lang = next;
  }
}

/**
 * Resolve a stored preference into the locale actually used.
 *
 * `null` in settings means "follow the OS", and this is the one place that decides
 * what that resolves to — keeping it out of both the component and the settings
 * schema means neither has to know about `navigator`.
 */
export function resolveLocale(stored: Locale | null): Locale {
  return stored ?? detectLocale();
}
