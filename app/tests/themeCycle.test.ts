import { test } from "node:test";
import assert from "node:assert/strict";
import { THEME_CYCLE, THEME_LABEL_KEYS, nextTheme, themeSequence } from "../src/lib/themeCycle.ts";
import { translate } from "../src/lib/i18n.ts";
import type { ThemeMode } from "../src/lib/settings.ts";

/*
 * The appearance control is one button that cycles three modes. Every way that
 * can go wrong is an ordering bug, and none of them are visible by reading the
 * template: a mode skipped, a mode needing two clicks, a cycle that ends
 * somewhere other than where it started.
 */

// --- the cycle --------------------------------------------------------------

test("a click from every mode lands on a different mode", () => {
  for (const mode of THEME_CYCLE) {
    assert.notEqual(nextTheme(mode), mode, `${mode} must not be a no-op`);
  }
});

test("the cycle visits every mode exactly once", () => {
  // Walk a full cycle from each starting point; the visited set must be all three.
  for (const start of THEME_CYCLE) {
    const visited = [start, ...themeSequence(start, THEME_CYCLE.length - 1)];
    assert.deepEqual(
      [...new Set(visited)].sort(),
      [...THEME_CYCLE].sort(),
      `cycle from ${start} skipped a mode: ${visited.join(" → ")}`,
    );
  }
});

// The important one: the button must be a 3-cycle, so pressing it three times
// returns to the start. Anything else means one mode is unreachable in one click
// or the loop has a trap.
test("three clicks return to the starting mode", () => {
  for (const start of THEME_CYCLE) {
    assert.equal(themeSequence(start, 3).at(-1), start, `cycle from ${start} does not close`);
  }
});

// The two concrete modes should be adjacent: switching between light and dark is
// the common action and must not require passing through "system".
test("light and dark are one click apart", () => {
  assert.equal(nextTheme("light"), "dark");
  assert.equal(nextTheme("dark"), "system");
  // …and system is one click back to light, closing the loop.
  assert.equal(nextTheme("system"), "light");
});

test("the declared order matches the actual cycle", () => {
  for (let i = 0; i < THEME_CYCLE.length; i++) {
    const from = THEME_CYCLE[i];
    const to = THEME_CYCLE[(i + 1) % THEME_CYCLE.length];
    assert.equal(nextTheme(from), to, `${from} should lead to ${to}`);
  }
});

// A stale value from an older build's localStorage must not render an empty
// button; falling back to a known mode is better than `undefined`.
test("an unknown mode falls back to the first entry", () => {
  assert.equal(nextTheme("nope" as ThemeMode), THEME_CYCLE[0]);
  assert.equal(nextTheme("" as ThemeMode), THEME_CYCLE[0]);
});

// --- labels -----------------------------------------------------------------

// The labels are message keys now, resolved through the catalogue, so the modes
// follow the language store instead of being frozen at module load.
test("every mode maps to a translated label", () => {
  for (const mode of THEME_CYCLE) {
    const key = THEME_LABEL_KEYS[mode];
    assert.ok(key, `missing label key for ${mode}`);
    for (const locale of ["en", "zh-Hans", "ja"] as const) {
      const text = translate(locale, key);
      assert.notEqual(text.trim(), "", `${locale}:${key} is blank`);
      assert.ok(!text.includes("."), `${locale}:${key} looks like an unresolved key`);
    }
  }
});

// The tooltip names the current state *and* the affordance, via the theme.title
// template so every language can put the mode name where it belongs.
test("the tooltip names the current mode and the action", () => {
  for (const mode of THEME_CYCLE) {
    const name = translate("en", THEME_LABEL_KEYS[mode]);
    const title = translate("en", "theme.title", { name });
    assert.ok(title.includes(name), `${title} must name ${mode}`);
    assert.ok(/switch/i.test(title), `${title} must say what a click does`);
  }
});

// The accessible name reports the state, not the action: a screen-reader user
// hearing "Appearance: Dark" knows the mode without pressing anything.
test("the accessible label reports the state, not the action", () => {
  for (const mode of THEME_CYCLE) {
    const name = translate("en", THEME_LABEL_KEYS[mode]);
    const label = translate("en", "theme.ariaLabel", { name });
    assert.ok(label.includes(name));
    assert.ok(!/click|switch/i.test(label), "the aria-label must not describe the action");
  }
});

// --- the icon -----------------------------------------------------------------

/*
 * The icons are in the template, so read the source. This guards the specific
 * regression that made the settings button look like a duplicate: a gear whose
 * radiating teeth are indistinguishable from the sun icon's sun rays at 14px.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const toolbar = readFileSync(
  fileURLToPath(new URL("../src/lib/Toolbar.svelte", import.meta.url)),
  "utf8",
);

test("the appearance button renders one icon per mode", () => {
  const section = toolbar.slice(
    toolbar.indexOf("Appearance as a single cycling button"),
    toolbar.indexOf("Settings entry point"),
  );
  // Three `{#if}` branches, each with an svg.
  assert.equal((section.match(/<svg/g) ?? []).length, 3, "expected three mode icons");
  assert.ok(section.includes('themeMode === "light"'));
  assert.ok(section.includes('themeMode === "dark"'));
});

// The settings icon must not share geometry with the sun icon. A gear drawn as a
// circle plus eight radiating strokes *is* a sun at this size.
test("the settings icon is not a circle with radiating teeth", () => {
  const section = toolbar.slice(toolbar.indexOf("Settings entry point"));
  const svgEnd = section.indexOf("</svg>");
  const icon = section.slice(0, svgEnd);

  assert.ok(!icon.includes("<circle cx=\"8\" cy=\"8\" r=\"2.2\""), "that circle is the old gear hub");
  // The specific teeth path of the old gear must be gone.
  assert.ok(
    !icon.includes("M8 1.6v1.6M8 12.8v1.6"),
    "the gear's radiating teeth read as sun rays at 14px",
  );
});

test("the appearance control is one button, not a three-segment group", () => {
  const section = toolbar.slice(
    toolbar.indexOf("Appearance as a single cycling button"),
    toolbar.indexOf("Settings entry point"),
  );
  // The old control was a radiogroup of three radios.
  assert.ok(!section.includes('role="radiogroup"'), "the segmented group is gone");
  assert.ok(!section.includes('role="radio"'), "the radios are gone");
  assert.equal((section.match(/<button/g) ?? []).length, 1, "exactly one button remains");
});
