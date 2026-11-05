import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * The expanded-run collapse control is absolutely positioned because the virtual
 * scroller requires every display item to occupy exactly one row height. It must
 * stay centred on the gutter/code boundary: placing it after the gutter made the
 * pill cover the first characters of every expanded block.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/DiffPane.svelte", import.meta.url)),
  "utf8",
);
const APP_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/App.svelte", import.meta.url)),
  "utf8",
);
const CODE_LINE_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/CodeLine.svelte", import.meta.url)),
  "utf8",
);
const UNIFIED_SOURCE = readFileSync(
  fileURLToPath(new URL("../src/lib/UnifiedView.svelte", import.meta.url)),
  "utf8",
);

function styleRuleIn(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `no style rule for ${selector}`);
  return match[1];
}

function styleRule(selector: string): string {
  return styleRuleIn(SOURCE, selector);
}

test("the expanded-run collapse control stays in the gutter padding", () => {
  const button = SOURCE.slice(
    SOURCE.indexOf('class="collapse"'),
    SOURCE.indexOf("</button>", SOURCE.indexOf('class="collapse"')),
  );
  const rule = styleRule(".collapse");

  assert.match(button, /aria-label=\{\$t\("fold\.collapse"/);
  assert.doesNotMatch(button, /fold\.collapseShort/, "the count belongs in the tooltip");
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /width:\s*16px/);
  assert.match(rule, /height:\s*16px/);
  assert.match(rule, /left:\s*max\(0px,\s*calc\(var\(--gutter-width\)\s*-\s*8px\)\)/);
  assert.doesNotMatch(
    rule,
    /left:\s*calc\(var\(--gutter-width\)\s*\+\s*8px\)/,
    "the control must not start inside the code column",
  );
});

test("turning wrapping on does not replace the current diff view", () => {
  const handler = APP_SOURCE.match(/onToggleWrap=\{([^}]*)\}/)?.[1] ?? "";
  assert.match(handler, /toggleWrapLines/);
  const toggle = APP_SOURCE.match(
    /async function toggleWrapLines\(\)[\s\S]*?\n  \}/,
  )?.[0] ?? "";
  assert.match(toggle, /patchSettings\(\{ wrapLines:/);
  assert.doesNotMatch(toggle, /\bview\s*=/, "wrapping must not switch split to inline");
});

test("wrap width is re-measured after the active view changes", () => {
  const start = APP_SOURCE.indexOf("Keep the wrap capacity tied to the current view");
  const end = APP_SOURCE.indexOf("/**", start + 1);
  const effect = APP_SOURCE.slice(start, end === -1 ? undefined : end);

  assert.match(effect, /const mode = view/);
  assert.match(effect, /requestAnimationFrame\(measure\)/);
  assert.match(effect, /observer\.observe\(host\)/);
});

test("wrapping uses measured Latin and CJK advances instead of column estimates", () => {
  assert.match(APP_SOURCE, /let wideCharWidth = \$state/);
  assert.match(APP_SOURCE, /const wrapMetrics = \$derived\(\{ charWidth, wideCharWidth \}\)/);
  assert.match(APP_SOURCE, /expandSplitWrapped\([\s\S]*?wrapMetrics\)/);
  assert.match(APP_SOURCE, /expandUnifiedWrapped\([\s\S]*?wrapMetrics\)/);
  assert.doesNotMatch(APP_SOURCE, /displayWidth\(/);
});

test("wrapped split panes discard every horizontal offset", () => {
  assert.match(APP_SOURCE, /scrollLeft=\{settings\.wrapLines \? 0 : scrollLeft\}/);
  assert.match(APP_SOURCE, /wrapped=\{settings\.wrapLines\}/);
  assert.match(SOURCE, /class:wrapped/);
  assert.match(SOURCE, /if \(isWrapped && scroller\.scrollLeft !== 0\)/);
  assert.match(SOURCE, /left: wrapped \? 0 : scroller\.scrollLeft/);

  const pane = styleRule(".pane.wrapped");
  assert.match(pane, /overflow-x:\s*hidden/);
  assert.match(pane, /overflow-y:\s*auto/);
  assert.match(styleRule(".pane.wrapped .window"), /width:\s*100%/);
  assert.match(styleRule(".pane.wrapped .row"), /min-width:\s*0/);
});

test("wrapped cells cannot recreate intrinsic-width horizontal overflow", () => {
  assert.match(CODE_LINE_SOURCE, /class:wrapped/);
  assert.match(styleRuleIn(CODE_LINE_SOURCE, ".cell.wrapped"), /width:\s*100%/);
  assert.match(styleRuleIn(CODE_LINE_SOURCE, ".cell.wrapped"), /min-width:\s*0/);
  assert.match(styleRuleIn(CODE_LINE_SOURCE, ".cell.wrapped .code"), /flex:\s*1 1 auto/);
  assert.match(styleRuleIn(CODE_LINE_SOURCE, ".cell.wrapped .code"), /overflow:\s*hidden/);
});

test("wrapped unified view is also a strict no-horizontal-scroll mode", () => {
  assert.match(APP_SOURCE, /wrapped=\{settings\.wrapLines\}/);
  assert.match(UNIFIED_SOURCE, /class:wrapped/);
  assert.match(UNIFIED_SOURCE, /if \(noHorizontalScroll && scroller\.scrollLeft !== 0\)/);
  assert.match(styleRuleIn(UNIFIED_SOURCE, ".unified.wrapped"), /overflow-x:\s*hidden/);
  assert.match(styleRuleIn(UNIFIED_SOURCE, ".unified.wrapped .window"), /width:\s*100%/);
});
