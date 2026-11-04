import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGUES, LOCALES } from "../src/lib/i18n.ts";

/*
 * Settings-sheet layout guards.
 *
 * The bug these exist for was invisible to every other check: the panel is a
 * fixed-width side sheet, the labels are translated, and a translation long enough
 * to overflow did not throw, fail the type check, or break a test — it pushed the
 * sheet from 320px to 560px in French, dragged a horizontal scrollbar under every
 * section, and made the whole panel look broken. Only a rendered measurement
 * caught it, and measurement is not available to `npm test`.
 *
 * So these tests assert the two *invariants* that measurement established, at the
 * level where they are decided: the width rules that stop a long string from
 * widening the sheet, and a character-budget check over the strings that sit in
 * the narrowest columns.
 */

const LIB = new URL("../src/lib/", import.meta.url).pathname;

function read(name: string): string {
  return readFileSync(join(LIB, name), "utf8");
}

/** Flat rules of a `.svelte` file's `<style>` block, comments stripped. */
function rules(source: string): { selector: string; body: string }[] {
  const at = source.indexOf("<style>");
  if (at === -1) return [];
  // Drop the tag itself, or it ends up glued to the first selector.
  const css = source.slice(at + "<style>".length).replace(/\/\*[\s\S]*?\*\//g, "");
  const out: { selector: string; body: string }[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    out.push({ selector: m[1].trim(), body: m[2] });
  }
  return out;
}

const SHEET = read("SettingsPanel.svelte");
const SHEET_RULES = rules(SHEET);

function rule(selector: string): string {
  const found = SHEET_RULES.find((r) => r.selector === selector);
  assert.ok(found, `no rule for ${selector}`);
  return found.body;
}

// --- width containment ------------------------------------------------------

/*
 * A flex item's automatic minimum size is its min-content width. The sheet holds
 * long single-line strings, so without an explicit `min-width: 0` the fixed
 * `flex-basis` is advisory and the panel grows with the language.
 */
test("the sheet pins its width against a long string in a child", () => {
  const body = rule(".sheet");
  assert.match(body, /flex:\s*0 0 \d+px/, "a fixed basis");
  assert.match(body, /min-width:\s*0/, "and a floor that overrides min-content");
});

// Same reasoning one level down: a label beside a control may wrap, but its
// min-content width must not exceed the row.
test("settings rows cannot be widened by their label", () => {
  const body = rule(".row-label");
  assert.match(body, /min-width:\s*0/, "the label may shrink");
  assert.doesNotMatch(body, /flex:\s*0 0 auto/);
});

test("the scrolling box hides horizontal overflow", () => {
  // Belt and braces: with the rules above nothing overflows, but a future 10px
  // string in an untested language should cost one clipped word, not a scrollbar
  // that shifts every section.
  assert.match(rule(".scroll"), /overflow-x:\s*hidden/);
});

// The footer caption is a whole sentence. Left in the 320px footer it either
// wrapped under the panel's bottom edge or lost most of its characters to an
// ellipsis; it now lives at the end of the scrolled content, where it has a full
// row and can wrap.
test("the footer holds only the reset button", () => {
  const foot = SHEET.slice(SHEET.indexOf('<footer class="foot">'), SHEET.indexOf("</footer>"));
  assert.match(foot, /class="reset"/);
  assert.doesNotMatch(foot, /class="note"|class="foot-note"/, "the caption moved out of the 34px footer");
  assert.match(rule(".foot"), /min-width:\s*0/);
  assert.match(rule(".foot-note"), /line-height/);
});

// --- character budgets ------------------------------------------------------

/*
 * The narrow columns, and how much text they can hold at the panel's real font
 * sizes. Measured against the shipped layout, then given the margin the widest
 * shipped translation already uses.
 *
 * These are budgets, not pixel measurements: a CJK glyph is roughly one em and a
 * Latin one roughly half, which is the quantity that decides whether a string fits
 * a 305px interior. A translation that exceeds its budget is a layout change to
 * review, not necessarily a bug — but it should fail here first, loudly, instead of
 * silently widening the panel.
 */
function columns(text: string): number {
  let em = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // CJK, Hangul, kana and fullwidth forms are one em wide; everything else is
    // about half an em in this UI's sans stack.
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xfe30 && code <= 0xfe6f) ||
      (code >= 0xff00 && code <= 0xff60) ||
      (code >= 0xffe0 && code <= 0xffe6);
    em += wide ? 1 : 0.55;
  }
  return em;
}

/** Widths in px of a row's non-label parts, measured from the shipped CSS. */
const TRACK = 56 + 72 + 12; // minimum track, value readout, gap
const INTERIOR = 305; // 320px sheet minus 2 × 12px padding, minus the scrollbar
const LABEL_PX = 12; // `.row-label` font size

for (const key of [
  "settings.foldThreshold",
  "settings.splitRatio",
  "settings.lineHeight",
  "settings.fontSize",
  "settings.intensity",
] as const) {
  test(`slider label "${key}" fits beside its track in every locale`, () => {
    const failures: string[] = [];
    for (const locale of LOCALES) {
      const value = CATALOGUES[locale][key];
      const px = columns(value) * LABEL_PX;
      if (px + TRACK > INTERIOR) {
        failures.push(`${locale}: "${value}" needs ${Math.round(px)}px + ${TRACK}px tooling`);
      }
    }
    assert.deepEqual(failures, []);
  });
}

test("the settings caption still fits where it is now allowed to wrap", () => {
  // A sanity check on the move: at 305px and 10px type, the longest shipped
  // caption must wrap to at most three lines, or the section *is* the problem.
  const failures: string[] = [];
  for (const locale of LOCALES) {
    const value = CATALOGUES[locale]["settings.note"];
    const px = columns(value) * 10;
    const lines = Math.ceil(px / INTERIOR);
    if (lines > 3) failures.push(`${locale}: ${lines} lines`);
  }
  assert.deepEqual(failures, []);
});
