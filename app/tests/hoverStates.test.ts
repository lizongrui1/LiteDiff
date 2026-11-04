import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/*
 * Two classes of regression that only a source-level check can catch.
 *
 * 1. **Selected controls must stay selected under the pointer.** This was a CSS
 *    specificity bug: `.btn.active` is (0,2,0) while `:hover:not(:disabled)` is
 *    (0,3,0), so hovering a toggled-on button replaced its blue chip with the
 *    neutral hover wash, and the blue only returned when the pointer left. No
 *    jsdom test can see this (no cascade) and asserting a class name cannot either
 *    (the class was always correct). What *can* be checked is the rule shape that
 *    makes it possible: a `:hover` rule that also matches the selected element.
 *
 * 2. **Every icon path must carry a `d` attribute.** An earlier edit deleted
 *    `d="m10 4-4 4 4 4"` from the "previous difference" arrow, and the button
 *    silently became an empty 14x14 box with no visible glyph and no build error.
 */

const LIB = new URL("../src/lib/", import.meta.url).pathname;
const SRC = new URL("../src/", import.meta.url).pathname;

function read(name: string): string {
  return readFileSync(join(LIB, name), "utf8");
}

/**
 * Every flat CSS rule in a `.svelte` file's `<style>` section.
 *
 * Comments are stripped first: a `/* ... *\/` block before a selector was being
 * captured as part of the selector text, which made every lookup miss.
 * These files use no nested at-rules, so a flat scan is sufficient.
 */
function rules(source: string): { selector: string; body: string }[] {
  const at = source.indexOf("<style>");
  if (at === -1) return [];
  const css = source
    .slice(at + "<style>".length)
    .replace(/\/\*[\s\S]*?\*\//g, "");

  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const selector = m[1].trim();
    if (selector === "") continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

/** All rules in `file` that style `base` with `:hover`. */
function hoverRulesFor(file: string, base: string) {
  return rules(read(file)).filter(
    (r) => r.selector.includes(base) && r.selector.includes(":hover"),
  );
}

/**
 * Hover rules for `base` that can also match the selected element.
 *
 * Exempt are the two safe shapes:
 *   - `.btn.active:hover`  — requires the selected class, so it cannot match an
 *                            unselected button (this is the intended active hover);
 *   - `.btn:hover:not(.active)` — explicitly excludes it.
 *
 * Anything else is the bug.
 */
function unscopedHoverRules(file: string, base: string, marker: string) {
  return hoverRulesFor(file, base).filter((r) => {
    if (r.selector.includes(`${base}${marker}`)) return false;
    if (r.selector.includes(`:not(${marker})`)) return false;
    return true;
  });
}

/** The baseline (non-hover) rule that defines the selected appearance. */
function selectedRulesFor(file: string, base: string, marker: string) {
  return rules(read(file)).filter((r) =>
    r.selector.split(",").some((s) => s.trim() === `${base}${marker}`),
  );
}

function backgroundOf(body: string): string {
  return /background:\s*([^;]+);/.exec(body)?.[1]?.trim() ?? "";
}

// --- toolbar: hover must not repaint an active button ------------------------

test("the toolbar has hover rules at all", () => {
  assert.ok(hoverRulesFor("Toolbar.svelte", ".btn").length > 0);
});

test("no toolbar hover rule can match the active button", () => {
  const bad = unscopedHoverRules("Toolbar.svelte", ".btn", ".active");
  assert.deepEqual(
    bad.map((r) => r.selector),
    [],
    "a plain .btn:hover rule outranks .btn.active and repaints it on hover",
  );
});

// The active button still needs hover feedback, or it feels inert — but it must
// stay blue rather than reverting to the neutral wash.
test("an active toolbar button deepens its accent instead of reverting", () => {
  const activeHover = rules(read("Toolbar.svelte")).find(
    (r) => r.selector.includes(".btn.active") && r.selector.includes(":hover"),
  );
  assert.ok(activeHover, "expected a .btn.active:hover rule");

  const bg = backgroundOf(activeHover.body);
  assert.ok(bg.startsWith("var(--c-selection"), `active hover must use the accent wash, got ${bg}`);
  assert.ok(!bg.includes("bg-sunken"), "the neutral wash is what made it look deselected");
});

// Guards against "fixing" the specificity bug by deleting the selected style,
// which would make the tests above pass while the button lost its colour.
test("the toolbar still has an active background rule", () => {
  const sel = selectedRulesFor("Toolbar.svelte", ".btn", ".active");
  assert.ok(sel.length > 0, "expected a .btn.active rule");
  assert.ok(backgroundOf(sel[0].body).includes("--c-selection"));
});

// --- git panel: same trap on three controls ---------------------------------

for (const [base, label] of [
  [".item", "file row"],
  [".seg", "view switch"],
  [".ab", "assign button"],
] as const) {
  test(`the git panel ${label} hover cannot match its selected state`, () => {
    assert.ok(hoverRulesFor("GitPanel.svelte", base).length > 0, `expected ${base}:hover`);
    const bad = unscopedHoverRules("GitPanel.svelte", base, ".on");
    assert.deepEqual(
      bad.map((r) => r.selector),
      [],
      `${base}:hover outranks ${base}.on`,
    );
  });

  test(`the git panel ${label} still has a selected style`, () => {
    assert.ok(
      selectedRulesFor("GitPanel.svelte", base, ".on").length > 0,
      `expected ${base}.on`,
    );
  });
}

// --- palette ----------------------------------------------------------------

// `selectionStrong` exists only for "selected control under the pointer". Missing
// from a palette would make the rule above resolve to nothing, silently.
test("every palette defines a stronger selection wash", () => {
  const hits = read("theme.ts").match(/selectionStrong:\s*rgba\(/g) ?? [];
  assert.ok(hits.length >= 2, `expected dark and light palettes to set it, found ${hits.length}`);
});

test("the stronger wash is actually stronger than the base one", () => {
  const pairs = [
    ...read("theme.ts").matchAll(
      /selection:\s*rgba\(accentRgb,\s*([\d.]+)\)[,\n]\s*selectionStrong:\s*rgba\(accentRgb,\s*([\d.]+)\)/g,
    ),
  ];
  assert.ok(pairs.length >= 2, `expected two palette pairs, found ${pairs.length}`);
  for (const [, base, strong] of pairs) {
    assert.ok(Number(strong) > Number(base), `selectionStrong (${strong}) > selection (${base})`);
  }
});

// --- icon paths -------------------------------------------------------------

/** Every `.svelte` file under `src/`, including nested component folders. */
function svelteFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".svelte")) out.push(full);
    }
  };
  walk(SRC);
  return out;
}

// A `<path>` with no `d` renders nothing and throws no error: the button keeps its
// size and hover behaviour, so the only symptom is a blank square.
test("every svg path has a d attribute", () => {
  const offenders: string[] = [];
  for (const file of svelteFiles()) {
    const source = readFileSync(file, "utf8");
    for (const m of source.matchAll(/<path\b([^>]*)>/gs)) {
      if (!/\bd=/.test(m[1])) {
        const line = source.slice(0, m.index).split("\n").length;
        offenders.push(`${file.split("/src/")[1]}:${line}`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a path without d= draws nothing");
});

// The specific button that broke: guard its direction as well as its existence, so
// restoring it as a right-pointing arrow would not pass.
test("the previous/next difference arrows point opposite ways", () => {
  const toolbar = read("Toolbar.svelte");
  // The labels are message keys now, so the anchors are too.
  const prev = toolbar.slice(
    toolbar.indexOf('$t("toolbar.prevDiff")'),
    toolbar.indexOf('$t("toolbar.nextDiff")'),
  );
  const next = toolbar.slice(toolbar.indexOf('$t("toolbar.nextDiff")'));

  const prevD = /d="([^"]+)"/.exec(prev)?.[1] ?? "";
  const nextD = /d="([^"]+)"/.exec(next)?.[1] ?? "";

  assert.ok(prevD.length > 0, "the previous-difference arrow has no path data");
  assert.ok(nextD.length > 0, "the next-difference arrow has no path data");
  // Left-pointing geometry starts by moving left before drawing the chevron.
  assert.ok(prevD.startsWith("m10 4"), `expected a left arrow, got ${prevD}`);
  assert.ok(nextD.startsWith("m6 4"), `expected a right arrow, got ${nextD}`);
});

// --- row width ---------------------------------------------------------------
//
// The "white band on the right after scrolling" bug: a row tinted only as far as
// its own text, leaving the pane's plain background visible past the last
// character. It cannot be caught in jsdom (no layout), so the rule shape is
// asserted instead.

test("a row's minimum width is its content, not a percentage of the window", () => {
  const css = read("DiffPane.svelte");
  const row = rules(css).find((r) => r.selector === ".row");
  assert.ok(row, "expected a .row rule");

  // `width: 100%` makes the row span the scroll width; `min-width: max-content`
  // keeps it at least as wide as its own text. Without the second, a row whose
  // cell does not stretch stops at the last character.
  assert.match(row.body, /min-width:\s*max-content/, "the row must not shrink below its content");
  assert.ok(
    !/min-width:\s*100%/.test(row.body),
    "min-width: 100% resolves against max-content and lets short rows fall short",
  );
});
