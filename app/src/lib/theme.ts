/**
 * Design tokens.
 *
 * Colour values come from the visual spec verbatim: low-saturation row tints,
 * high-saturation pills on top, and a strict ban on `#FF0000` / `#00FF00`.
 * Everything is expressed as HSL-free rgba so the same token works over any
 * surface without colour-mixing surprises.
 *
 * The dark palette is not "inverted light": it keeps the same hue and raises
 * alpha, because an 8% rose over #1c1c1e is invisible.
 *
 * Palettes are *generated* rather than hand-written, because the settings screen
 * lets the user pick a colour scheme and an intensity. `light` and `dark` remain
 * exported as the default look so existing call sites (and the palette tests)
 * keep working against a concrete palette.
 */

/** 0-255 channels, so alpha can be re-applied per theme without string surgery. */
type RGB = readonly [number, number, number];

export type SchemeName = "classic" | "colorblind" | "muted";
export type IntensityName = "soft" | "normal" | "strong";

export interface Palette {
  /** App chrome. */
  bg: string;
  bgElevated: string;
  bgSunken: string;
  border: string;
  borderStrong: string;

  text: string;
  textMuted: string;
  textFaint: string;

  /** Row tints (low saturation, full-row background). */
  delRow: string;
  insRow: string;
  /** Intra-line pills (high saturation, on top of the row tint). */
  delPill: string;
  insPill: string;
  /** Text colour inside a pill, for contrast. */
  delPillText: string;
  insPillText: string;
  /** Solid stripe marking the leading edge of a changed row. */
  delEdge: string;
  insEdge: string;
  /** Gutter number colour once the gutter carries the change tint. */
  delGutterText: string;
  insGutterText: string;

  /** Hatched placeholder for a missing side. */
  hatchLine: string;
  hatchBg: string;

  /** Gutter. */
  gutterText: string;
  gutterTextActive: string;
  gutterBg: string;

  /** Selection / focus. */
  accent: string;
  selection: string;
  /**
   * Stronger form of {@link selection}, for a selected control under the pointer.
   *
   * A selected button still has to acknowledge hover, but it cannot fall back to
   * the neutral hover wash — that would read as "deselected". So the same accent
   * wash is deepened instead, keeping the button unmistakably active.
   */
  selectionStrong: string;
  /** Minimap. */
  minimapBg: string;
  minimapDel: string;
  minimapIns: string;
  minimapMod: string;
  minimapViewport: string;

  /** Fold bar. */
  foldBg: string;
  foldText: string;

  /**
   * Syntax colours.
   *
   * Only five roles, because a diff already spends colour on add/remove: a token
   * palette as wide as an editor theme would compete with the tints that carry the
   * actual information. These are chosen to sit *under* the change colours — muted,
   * no pure hues — so a red row still reads as removed rather than as a string.
   *
   * `syntaxText` is deliberately absent: ordinary code stays `text`, which is what
   * makes the coloured tokens stand out.
   */
  syntaxKeyword: string;
  syntaxType: string;
  syntaxFunction: string;
  syntaxString: string;
  syntaxNumber: string;
  syntaxComment: string;
  syntaxPunctuation: string;
}

/** The colour choices a palette is built from. */
export interface Look {
  accent: string;
  scheme: SchemeName;
  intensity: IntensityName;
}

/**
 * Hue pair per scheme.
 *
 * `classic` is the default rose/green from the visual spec. `colorblind` swaps to
 * blue/amber, which stays distinguishable under deuteranopia and protanopia
 * without touching the banned pure red/green. `muted` desaturates both toward
 * grey, for readers who find the default too loud next to syntax colouring.
 *
 * Gutter numbers are listed separately because they are *text*: at the row's
 * 8% alpha a number would be unreadable, so each hue needs an explicit
 * higher-contrast variant per theme.
 */
interface SchemePair {
  del: RGB;
  ins: RGB;
  lightGutter: { del: RGB; ins: RGB };
  darkGutter: { del: RGB; ins: RGB };
}

const SCHEMES: Record<SchemeName, SchemePair> = {
  classic: {
    del: [244, 63, 94],
    ins: [34, 197, 94],
    lightGutter: { del: [159, 18, 57], ins: [21, 128, 61] },
    darkGutter: { del: [253, 164, 175], ins: [134, 239, 172] },
  },
  colorblind: {
    del: [59, 130, 246],
    ins: [217, 119, 6],
    lightGutter: { del: [30, 64, 175], ins: [146, 64, 14] },
    darkGutter: { del: [147, 197, 253], ins: [252, 211, 77] },
  },
  muted: {
    del: [168, 112, 124],
    ins: [116, 154, 124],
    lightGutter: { del: [122, 68, 82], ins: [72, 104, 82] },
    darkGutter: { del: [226, 173, 184], ins: [172, 206, 180] },
  },
};

/**
 * How strongly the tints are applied.
 *
 * Only the washes scale: the leading-edge stripe stays near-solid at every
 * intensity, because it is the marker that survives a faint row tint. Scaling it
 * down with the rows is what makes "soft" look broken rather than subtle.
 */
const INTENSITY: Record<IntensityName, { wash: number; edge: number }> = {
  soft: { wash: 0.72, edge: 0.9 },
  normal: { wash: 1, edge: 1 },
  strong: { wash: 1.3, edge: 1 },
};

const DEFAULT_ACCENT = "#0a84ff";

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function rgba(rgb: RGB, alpha: number): string {
  // Three decimals: enough to be exact, short enough to read in devtools.
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${Number(clamp01(alpha).toFixed(3))})`;
}

function hexToRgb(hex: string): RGB {
  const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
  if (!m) return [10, 132, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * Build a full palette for one theme and look.
 *
 * Base chrome (surface, text, borders) is fixed per theme: only the change
 * colours and the accent are user-configurable, because a half-recoloured window
 * reads as a bug rather than a preference.
 */
export function buildPalette(isDark: boolean, look: Partial<Look> = {}): Palette {
  const scheme = SCHEMES[look.scheme ?? "classic"] ?? SCHEMES.classic;
  const wash = INTENSITY[look.intensity ?? "normal"] ?? INTENSITY.normal;
  const accent = look.accent ?? DEFAULT_ACCENT;
  const accentRgb = hexToRgb(accent);

  // Wash alphas per theme, before the intensity multiplier.
  const rowA = (isDark ? 0.16 : 0.08) * wash.wash;
  const pillA = (isDark ? 0.38 : 0.28) * wash.wash;
  const edgeA = (isDark ? 0.95 : 0.85) * wash.edge;
  const minimapA = (isDark ? 0.62 : 0.55) * wash.wash;
  const gutter = isDark ? scheme.darkGutter : scheme.lightGutter;
  const pillText = isDark ? "rgba(255, 255, 255, 0.95)" : "rgba(0, 0, 0, 0.90)";

  const chrome = isDark
    ? {
        bg: "#1c1c1e",
        bgElevated: "#232326",
        bgSunken: "#161618",
        border: "rgba(255, 255, 255, 0.10)",
        borderStrong: "rgba(255, 255, 255, 0.18)",
        text: "rgba(255, 255, 255, 0.90)",
        textMuted: "rgba(255, 255, 255, 0.56)",
        textFaint: "rgba(255, 255, 255, 0.34)",
        hatchLine: "rgba(255, 255, 255, 0.07)",
        hatchBg: "#191919",
        gutterText: "rgba(255, 255, 255, 0.28)",
        gutterTextActive: "rgba(255, 255, 255, 0.72)",
        gutterBg: "#1a1a1c",
        minimapBg: "#191919",
        minimapViewport: "rgba(255, 255, 255, 0.26)",
        foldBg: "#222225",
        foldText: "rgba(255, 255, 255, 0.52)",

        /*
         * Dark syntax colours: lightened, but desaturated. A keyword at full
         * saturation on #1c1c1e vibrates; these read as "different" without pulling
         * the eye off the change tints.
         */
        syntaxKeyword: "#c4a7f7",
        syntaxType: "#8fd3f4",
        syntaxFunction: "#7fd4d0",
        syntaxString: "#e0b088",
        syntaxNumber: "#e6c07b",
        /*
         * 0.46, not 0.30: a comment still has to be *read*. At 0.30 this was 2.9:1
         * against the pane, and the whole point of a diff is that the reader is
         * looking at the text. 0.46 gives ~4.6:1 and still sits clearly behind code.
         */
        syntaxComment: "rgba(255, 255, 255, 0.46)",
        syntaxPunctuation: "rgba(255, 255, 255, 0.62)",
        selection: rgba(accentRgb, 0.26),
        selectionStrong: rgba(accentRgb, 0.38),
      }
    : {
        bg: "#ffffff",
        bgElevated: "#f7f7f8",
        bgSunken: "#f0f0f2",
        border: "rgba(0, 0, 0, 0.10)",
        borderStrong: "rgba(0, 0, 0, 0.18)",
        text: "rgba(0, 0, 0, 0.88)",
        textMuted: "rgba(0, 0, 0, 0.55)",
        textFaint: "rgba(0, 0, 0, 0.32)",
        hatchLine: "rgba(0, 0, 0, 0.07)",
        hatchBg: "#fbfbfc",
        gutterText: "rgba(0, 0, 0, 0.30)",
        gutterTextActive: "rgba(0, 0, 0, 0.70)",
        gutterBg: "#fbfbfc",
        minimapBg: "#fafafb",
        minimapViewport: "rgba(0, 0, 0, 0.22)",
        foldBg: "#f2f2f4",
        foldText: "rgba(0, 0, 0, 0.50)",

        /*
         * Light syntax colours: darkened versions of the same hues, so the two
         * themes read as one scheme rather than two designs. Each is at least 4.5:1
         * against white, which is the point — a comment nobody can read is worse
         * than no comment colour.
         */
        syntaxKeyword: "#6f42c1",
        syntaxType: "#0b6ca8",
        syntaxFunction: "#0f6f74",
        syntaxString: "#a04e12",
        syntaxNumber: "#8a5a00",
        /* 0.55 gives ~4.7:1 against white; see the dark counterpart. */
        syntaxComment: "rgba(0, 0, 0, 0.55)",
        syntaxPunctuation: "rgba(0, 0, 0, 0.62)",
        selection: rgba(accentRgb, 0.16),
        selectionStrong: rgba(accentRgb, 0.26),
      };

  return {
    ...chrome,
    delRow: rgba(scheme.del, rowA),
    insRow: rgba(scheme.ins, rowA),
    delPill: rgba(scheme.del, pillA),
    insPill: rgba(scheme.ins, pillA),
    delPillText: pillText,
    insPillText: pillText,
    delEdge: rgba(scheme.del, edgeA),
    insEdge: rgba(scheme.ins, edgeA),
    delGutterText: rgba(gutter.del, 0.95),
    insGutterText: rgba(gutter.ins, 0.95),
    accent,
    minimapDel: rgba(scheme.del, minimapA),
    minimapIns: rgba(scheme.ins, minimapA),
    minimapMod: rgba(scheme.del, minimapA),
  };
}

/** The palette the app ships with: rose/green, no accent override. */
export const light: Palette = buildPalette(false);
export const dark: Palette = buildPalette(true);

/**
 * Serialise a palette into CSS custom properties on `:root`.
 *
 * `color-scheme` is set here, from the palette that was actually applied, and not
 * left at a fixed `light dark` in the stylesheet.
 *
 * That property controls the *native* parts of the window: scrollbar tracks and
 * thumbs, form control internals, the caret, and (on macOS) the title bar tint.
 * Pinning it to `light dark` meant those parts kept following the OS even after
 * the user forced the app to dark, so the chrome stayed light while the diff went
 * black — the window looked half-converted until a second toggle happened to line
 * the two up again.
 *
 * `dark` is inferred from the palette rather than passed in: `bg` is the one token
 * that is purely a surface colour, and every dark palette has a dark one.
 */
export function applyPalette(p: Palette, isDark?: boolean): void {
  const root = document.documentElement;
  for (const [key, value] of Object.entries(p)) {
    root.style.setProperty(`--c-${kebab(key)}`, value);
  }

  // Derive the scheme when the caller does not say, so the two can never disagree.
  const dark = isDark ?? isDarkSurface(p.bg);
  root.style.colorScheme = dark ? "dark" : "light";
}

/** True when a CSS colour is dark enough that native chrome should be dark too. */
function isDarkSurface(color: string): boolean {
  const hex = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(color.trim());
  if (!hex) return false;
  const [r, g, b] = [1, 2, 3].map((i) => parseInt(hex[i], 16));
  // Rec. 601 luma; the threshold only has to separate #1c1c1e from #ffffff.
  return 0.299 * r + 0.587 * g + 0.114 * b < 128;
}

function kebab(s: string): string {
  return s.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
}

/**
 * Metrics. Row height is the single source of truth for virtual scrolling:
 * every measurement in the viewport derives from it, so a change here cannot
 * desynchronise the two panes.
 *
 * These are *defaults*. The live values are held in reactive state in `App`
 * (font size and row height are user settings), and are written to CSS custom
 * properties, so the DOM and the arithmetic always read the same numbers.
 */
export const metrics = {
  rowHeight: 20,
  fontSize: 12,
  /**
   * Minimum gutter width in px.
   *
   * The gutter is not fixed at this value: the actual width is derived from the
   * document's largest line number (see `gutterWidthFor`). A fixed 52px clipped
   * fold ranges like `123–240` and five-digit numbers, which made the line
   * numbering look wrong at exactly the moments it mattered.
   */
  gutterWidth: 52,
  /** Extra rows rendered above and below the viewport. */
  overscan: 12,
  /** Unchanged runs longer than this (in rows) start folded. */
  foldThreshold: 10,
  /** Context rows kept above a jump target. */
  jumpContext: 3,
  minimapWidth: 10,
} as const;

/**
 * Monospace stack, matching `--font-mono` in `global.css`.
 *
 * JetBrains Mono first because it is bundled with the app (see the `@font-face`
 * block there), so it is present on every install; the rest is a graceful
 * fallback for the case where the font file fails to load.
 */
export const fontMono =
  '"JetBrains Mono", "SF Mono", ui-monospace, Menlo, Monaco, "Cascadia Mono", "Roboto Mono", monospace';
