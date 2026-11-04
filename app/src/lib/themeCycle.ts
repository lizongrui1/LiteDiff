/**
 * The appearance cycle behind the toolbar's theme button.
 *
 * Extracted from `Toolbar.svelte` so the cycle order can be tested directly. A
 * cycling control's failure modes are all ordering bugs — a mode that needs two
 * clicks, a mode that is skipped, a cycle that does not return to its start — and
 * none of them are visible by reading the JSX in the template.
 */

import type { ThemeMode } from "./settings";

/**
 * Cycle order for the appearance button.
 *
 * Light → dark → system, then back to light. Three properties fall out of this
 * order and all of them are wanted:
 *
 *   - Every mode is exactly one click from every other (it is a 3-cycle).
 *   - The two concrete choices are adjacent, so the common toggle between them
 *     needs one click rather than two.
 *   - "Follow the system" sits last, which reads as the most automatic option.
 */
export const THEME_CYCLE = ["light", "dark", "system"] as const satisfies readonly ThemeMode[];

/**
 * Message keys for the display names.
 *
 * Keys rather than text: the caller resolves them through `$t`, so the labels
 * follow the language store instead of being frozen at module load.
 */
export const THEME_LABEL_KEYS: Record<ThemeMode, "theme.light" | "theme.dark" | "theme.system"> = {
  light: "theme.light",
  dark: "theme.dark",
  system: "theme.system",
};

/**
 * The mode one click away.
 *
 * A value outside the cycle falls back to the first entry rather than producing
 * `undefined`: settings come from `localStorage`, which any earlier build could
 * have written, and a button that renders nothing is worse than one that resets
 * to a known mode.
 */
export function nextTheme(current: ThemeMode): ThemeMode {
  const at = THEME_CYCLE.indexOf(current);
  if (at === -1) return THEME_CYCLE[0];
  return THEME_CYCLE[(at + 1) % THEME_CYCLE.length];
}

/**
 * The full cycle starting from `current`, for tests and for the tooltip.
 *
 * Returns `count` entries: stepping that many times returns to the start.
 */
export function themeSequence(current: ThemeMode, count = THEME_CYCLE.length): ThemeMode[] {
  const out: ThemeMode[] = [];
  let mode = current;
  for (let i = 0; i < count; i++) {
    mode = nextTheme(mode);
    out.push(mode);
  }
  return out;
}

/*
 * The tooltip and accessible name are built in the component with `$t`, not here:
 * they are sentences with a placeholder, and every locale puts the mode name in a
 * different position ("Current: Dark" vs "当前：深色"). A helper that concatenated
 * them would fix the word order to the source language.
 */
