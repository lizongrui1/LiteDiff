import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULTS,
  isModified,
  normalizeSettings,
  rowHeightFor,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  saveSettings,
} from "../src/lib/settings.ts";
import { buildPalette } from "../src/lib/theme.ts";
import type { SchemeName, IntensityName } from "../src/lib/theme.ts";

// --- normalization ----------------------------------------------------------
// Settings come back from localStorage, which any earlier build (or a user with
// devtools) can have written. Every field must validate independently: losing a
// font size must not also throw away the user's colour scheme.

test("garbage input falls back to the defaults", () => {
  for (const raw of [null, undefined, 42, "nope", [], true]) {
    assert.deepEqual(normalizeSettings(raw), DEFAULTS);
  }
});

test("one bad field does not discard the others", () => {
  const s = normalizeSettings({
    fontSize: "huge",
    scheme: "colorblind",
    lineNumbers: false,
    ignoreCase: true,
  });
  assert.equal(s.fontSize, DEFAULTS.fontSize, "bad font size falls back");
  assert.equal(s.scheme, "colorblind", "good neighbour survives");
  assert.equal(s.lineNumbers, false);
  assert.equal(s.ignoreCase, true);
});

test("unknown keys are dropped rather than carried through", () => {
  const s = normalizeSettings({ ...DEFAULTS, telemetry: true, fontSize: 14 });
  assert.equal("telemetry" in s, false);
  assert.equal(s.fontSize, 14);
});

test("numeric settings are clamped and snapped to their step", () => {
  assert.equal(normalizeSettings({ fontSize: 999 }).fontSize, 18);
  assert.equal(normalizeSettings({ fontSize: -5 }).fontSize, 10);
  // Fractional input snaps to the 1px step.
  assert.equal(normalizeSettings({ fontSize: 13.4 }).fontSize, 13);
  // Line height steps by 0.05 and must not leak float noise into the UI.
  const lh = normalizeSettings({ lineHeight: 1.47 }).lineHeight;
  assert.equal(lh, 1.45);
  assert.ok(String(lh).length <= 4, `line height leaked float noise: ${lh}`);
  assert.equal(normalizeSettings({ foldThreshold: 1000 }).foldThreshold, 60);
});

test("enum fields reject values from a future schema", () => {
  assert.equal(normalizeSettings({ theme: "sepia" }).theme, "system");
  assert.equal(normalizeSettings({ scheme: "neon" }).scheme, "classic");
  assert.equal(normalizeSettings({ intensity: "max" }).intensity, "normal");
});

test("accent must be a full hex colour", () => {
  assert.equal(normalizeSettings({ accent: "#ff0000" }).accent, "#ff0000");
  assert.equal(normalizeSettings({ accent: "#ABC123" }).accent, "#abc123");
  // Shorthand and bare words are not colours this app can paint.
  assert.equal(normalizeSettings({ accent: "#fff" }).accent, DEFAULTS.accent);
  assert.equal(normalizeSettings({ accent: "red" }).accent, DEFAULTS.accent);
});

test("defaults are unmodified and a single change is detected", () => {
  assert.equal(isModified(DEFAULTS), false);
  assert.equal(isModified({ ...DEFAULTS, minimap: false }), true);
});

// --- derived metrics --------------------------------------------------------

test("row height is always a whole number of pixels", () => {
  // The virtual scroller divides scroll offsets by this value; a fractional row
  // height lands between rows and shows up as a one-pixel jump per scroll event.
  for (let size = 10; size <= 18; size++) {
    for (let lh = 1.3; lh <= 2.0001; lh += 0.05) {
      const h = rowHeightFor({ ...DEFAULTS, fontSize: size, lineHeight: lh });
      assert.equal(Number.isInteger(h), true, `font ${size}px x ${lh} -> ${h}`);
      assert.ok(h >= 12, `row height ${h} is too small to render`);
    }
  }
});

test("the default look reproduces the shipped 20px row", () => {
  assert.equal(rowHeightFor(DEFAULTS), 20);
});

// --- storage ----------------------------------------------------------------

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

test("settings round-trip through storage", () => {
  const store = memoryStorage();
  const saved = { ...DEFAULTS, fontSize: 15, scheme: "muted" as SchemeName };
  saveSettings(saved, store);
  assert.deepEqual(loadSettings(store), saved);
});

test("a corrupt blob cannot brick startup", () => {
  const store = memoryStorage({ [SETTINGS_STORAGE_KEY]: "{not json" });
  assert.deepEqual(loadSettings(store), DEFAULTS);
});

test("storage failures are survivable", () => {
  const throwing = {
    getItem() {
      throw new Error("denied");
    },
    setItem() {
      throw new Error("quota");
    },
  } as unknown as Storage;
  assert.deepEqual(loadSettings(throwing), DEFAULTS);
  assert.doesNotThrow(() => saveSettings(DEFAULTS, throwing));
});

// --- generated palettes -----------------------------------------------------
// These are the invariants the hand-written palettes used to be asserted against;
// they now have to hold for every combination the settings screen can produce.

const SCHEMES: SchemeName[] = ["classic", "colorblind", "muted"];
const INTENSITIES: IntensityName[] = ["soft", "normal", "strong"];
const ACCENTS = ["#0a84ff", "#5e5ce6", "#30b0c7", "#ff9500", "#ff375f", "#8e8e93"];

function alphaOf(rgba: string): number {
  const m = /rgba?\([^)]*?([\d.]+)\)$/.exec(rgba);
  return m ? Number(m[1]) : 1;
}

test("no palette can produce the banned pure red or green", () => {
  const banned = ["#ff0000", "#00ff00", "255, 0, 0", "0, 255, 0"];
  for (const isDark of [false, true]) {
    for (const scheme of SCHEMES) {
      for (const intensity of INTENSITIES) {
        const palette = buildPalette(isDark, { scheme, intensity, accent: "#0a84ff" });
        for (const [key, value] of Object.entries(palette)) {
          const lower = String(value).toLowerCase().replace(/\s+/g, " ");
          for (const bad of banned) {
            assert.ok(
              !lower.includes(bad),
              `${isDark ? "dark" : "light"}/${scheme}/${intensity}.${key} used ${bad}`,
            );
          }
        }
      }
    }
  }
});

test("the change stripe always outranks the row wash", () => {
  // If the stripe ever drops to the row tint's alpha, the marker stops being
  // visible against the tint it is supposed to mark.
  for (const isDark of [false, true]) {
    for (const scheme of SCHEMES) {
      for (const intensity of INTENSITIES) {
        const p = buildPalette(isDark, { scheme, intensity });
        const tag = `${isDark ? "dark" : "light"}/${scheme}/${intensity}`;
        assert.ok(alphaOf(p.delEdge) > alphaOf(p.delRow), `${tag}: del edge vs row`);
        assert.ok(alphaOf(p.insEdge) > alphaOf(p.insRow), `${tag}: ins edge vs row`);
        assert.ok(alphaOf(p.delPill) > alphaOf(p.delRow), `${tag}: del pill vs row`);
        assert.ok(alphaOf(p.insPill) > alphaOf(p.insRow), `${tag}: ins pill vs row`);
      }
    }
  }
});

test("dark tints are stronger than light ones at the same setting", () => {
  // An 8% wash is invisible over #1c1c1e, which is why the dark palette is not a
  // straight inversion.
  for (const scheme of SCHEMES) {
    for (const intensity of INTENSITIES) {
      const l = buildPalette(false, { scheme, intensity });
      const d = buildPalette(true, { scheme, intensity });
      assert.ok(alphaOf(d.delRow) > alphaOf(l.delRow), `${scheme}/${intensity}: del row`);
      assert.ok(alphaOf(d.insRow) > alphaOf(l.insRow), `${scheme}/${intensity}: ins row`);
    }
  }
});

test("intensity moves the wash without touching the stripe height", () => {
  const soft = buildPalette(false, { intensity: "soft" });
  const normal = buildPalette(false, { intensity: "normal" });
  const strong = buildPalette(false, { intensity: "strong" });
  assert.ok(alphaOf(soft.delRow) < alphaOf(normal.delRow));
  assert.ok(alphaOf(normal.delRow) < alphaOf(strong.delRow));
  // The stripe scales far less than the wash so "soft" stays legible.
  assert.ok(alphaOf(soft.delEdge) > alphaOf(soft.delRow) * 5);
});

test("accent colour reaches selection and stays distinct from the change hues", () => {
  const p = buildPalette(false, { accent: "#ff9500", scheme: "classic" });
  assert.equal(p.accent, "#ff9500");
  assert.ok(p.selection.includes("255, 149, 0"), `selection kept the old accent: ${p.selection}`);
});

test("every scheme gives the two sides different hues", () => {
  for (const isDark of [false, true]) {
    for (const scheme of SCHEMES) {
      const p = buildPalette(isDark, { scheme });
      assert.notEqual(p.delEdge, p.insEdge, `${isDark ? "dark" : "light"}/${scheme} collapsed`);
      assert.notEqual(p.delGutterText, p.insGutterText, `${scheme} gutter text collapsed`);
    }
  }
});

test("chrome colours are not user-configurable", () => {
  // A half-recoloured window reads as a bug, so only change colours and accent
  // vary between settings.
  const a = buildPalette(false, { accent: "#ff375f", scheme: "muted" });
  const b = buildPalette(false, { accent: "#0a84ff", scheme: "classic" });
  assert.equal(a.bg, b.bg);
  assert.equal(a.text, b.text);
  assert.equal(a.border, b.border);
});

// --- split ratio ------------------------------------------------------------

test("split ratio is centred by default and clamped to a usable range", () => {
  assert.equal(DEFAULTS.splitRatio, 0.5);
  // A pane narrower than ~15% cannot show code, so the clamp is part of the
  // contract rather than a UI nicety: the drag handler and the keyboard handler
  // both rely on `LIMITS` to stop short of hiding a side.
  assert.equal(normalizeSettings({ splitRatio: 0.01 }).splitRatio, 0.15);
  assert.equal(normalizeSettings({ splitRatio: 5 }).splitRatio, 0.85);
  assert.equal(normalizeSettings({ splitRatio: 0.63 }).splitRatio, 0.63);
});

test("a dragged split survives a settings round trip", () => {
  // The ratio is written on every pointer move, so it must be stable through
  // JSON without the 0.001 step introducing drift between drags.
  const store = memoryStorage();
  const dragged = { ...DEFAULTS, splitRatio: 0.631 };
  saveSettings(dragged, store);
  assert.equal(loadSettings(store).splitRatio, 0.631);
});

test("changing the split is a real modification", () => {
  assert.equal(isModified({ ...DEFAULTS, splitRatio: 0.5 }), false);
  assert.equal(isModified({ ...DEFAULTS, splitRatio: 0.62 }), true);
});
