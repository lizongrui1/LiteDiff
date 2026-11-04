import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CATALOGUES,
  LOCALES,
  LOCALE_META,
  FALLBACK_LOCALE,
  detectLocale,
  isLocale,
  matchLocale,
  translate,
} from "../src/lib/i18n.ts";

/*
 * A translation layer fails in ways that are invisible until a user in another
 * language opens the window: a missing key renders as the key name, a placeholder
 * that the translator dropped renders as literal `{n}`, a wrong order of `{index}`
 * and `{total}` renders a confusing sentence. None of that shows up in
 * `svelte-check`, because the types only guarantee the *keys* exist.
 */

const EN = CATALOGUES.en;
const KEYS = Object.keys(EN) as Array<keyof typeof EN>;

// --- completeness -----------------------------------------------------------

// The type system already enforces this, but only at compile time; asserting it
// here means `npm test` fails too, which is what a contributor without an editor
// integration will see.
test("every locale defines every key", () => {
  for (const locale of LOCALES) {
    const catalogue = CATALOGUES[locale] as Record<string, string>;
    const missing = KEYS.filter((k) => !(k in catalogue));
    assert.deepEqual(missing, [], `${locale} is missing ${missing.length} keys`);
  }
});

test("no locale has an empty string", () => {
  for (const locale of LOCALES) {
    const empties = KEYS.filter((k) => (CATALOGUES[locale] as Record<string, string>)[k]?.trim() === "");
    assert.deepEqual(empties, [], `${locale} has blank translations for ${empties.join(", ")}`);
  }
});

// A key whose value still equals the English text in a non-English locale is
// usually an untranslated stub. Some are legitimate (product name, "Git"), so the
// check is limited to keys that are clearly prose.
test("prose keys are actually translated", () => {
  const prose = KEYS.filter((k) => /Hint$|Title$|detail|\.bar$|note$/.test(k));
  const offenders: string[] = [];
  for (const locale of LOCALES) {
    if (locale === "en") continue;
    for (const key of prose) {
      const value = (CATALOGUES[locale] as Record<string, string>)[key];
      if (value === EN[key]) offenders.push(`${locale}:${key}`);
    }
  }
  // Chinese legitimately shares some short phrases with English only for the
  // product name, which is not in the prose set.
  assert.deepEqual(offenders, [], `untranslated prose: ${offenders.join(", ")}`);
});

// --- placeholders -----------------------------------------------------------

/** Placeholder names in a template string. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

// A dropped placeholder is silent data loss: the sentence still renders, just
// without the number it was about.
test("every translation keeps the placeholders of its English source", () => {
  const problems: string[] = [];
  for (const key of KEYS) {
    const expected = placeholders(EN[key]);
    if (expected.length === 0) continue;
    for (const locale of LOCALES) {
      if (locale === "en") continue;
      const found = placeholders((CATALOGUES[locale] as Record<string, string>)[key] ?? "");
      if (found.join(",") !== expected.join(",")) {
        problems.push(`${locale}:${key} expected {${expected.join("}{")}} got {${found.join("}{")}}`);
      }
    }
  }
  assert.deepEqual(problems, [], problems.join("\n"));
});

// The bug this catches: a translator "improves" a template and introduces `{n }`
// or `{count}` where the caller passes `n`, which renders literally.
test("no translation invents a placeholder the source does not have", () => {
  for (const key of KEYS) {
    const expected = placeholders(EN[key]);
    for (const locale of LOCALES) {
      const found = placeholders((CATALOGUES[locale] as Record<string, string>)[key] ?? "");
      for (const name of found) {
        assert.ok(
          expected.includes(name),
          `${locale}:${key} uses {${name}}, which the caller never passes`,
        );
      }
    }
  }
});

// --- interpolation ----------------------------------------------------------

test("placeholders are substituted", () => {
  assert.equal(translate("en", "fold.collapse", { n: 12 }), "Collapse these 12 unchanged lines");
  assert.equal(translate("zh-Hans", "fold.collapse", { n: 12 }), "折叠这 12 行未变动内容");
});

// A message that quotes a filename must not have placeholders inside that filename
// re-expanded: one pass only.
test("a substituted value is not scanned for placeholders", () => {
  const out = translate("en", "home.folderEmpty", { path: "/tmp/{n}/file.txt" });
  assert.ok(out.includes("{n}"), `the literal must survive, got: ${out}`);
});

test("a missing variable leaves the placeholder visible rather than blanking it", () => {
  // Blanking would silently produce "Collapse these  unchanged lines".
  const out = translate("en", "fold.collapse", {});
  assert.ok(out.includes("{n}"));
});

// --- lookup and fallback ----------------------------------------------------

test("an unknown locale falls back to English, not to a key name", () => {
  const out = translate("xx" as never, "toolbar.new");
  assert.equal(out, EN["toolbar.new"]);
});

// The last-resort behaviour: a key that is somehow absent still renders something
// identifiable. `undefined` in the DOM looks like a layout bug.
test("a missing key renders the key itself", () => {
  const out = translate("en", "nope.missing" as never);
  assert.equal(out, "nope.missing");
});

// --- locale matching --------------------------------------------------------

// The OS reports tags with regions and scripts; the app ships bare locales.
test("exact tags match case-insensitively", () => {
  assert.equal(matchLocale("en"), "en");
  assert.equal(matchLocale("EN"), "en");
  assert.equal(matchLocale("zh-Hans"), "zh-Hans");
  assert.equal(matchLocale("zh-hans"), "zh-Hans");
});

test("regional tags reduce to their base locale", () => {
  assert.equal(matchLocale("de-AT"), "de");
  assert.equal(matchLocale("fr-CA"), "fr");
  assert.equal(matchLocale("es-419"), "es");
  assert.equal(matchLocale("ja-JP"), "ja");
});

// Chinese needs script awareness: `zh-TW` is Traditional, `zh-CN` is Simplified,
// and a bare `zh` is ambiguous — Simplified is the majority reading.
test("Chinese tags resolve to the right script", () => {
  assert.equal(matchLocale("zh-Hant"), "zh-Hant");
  assert.equal(matchLocale("zh-Hant-TW"), "zh-Hant");
  assert.equal(matchLocale("zh-TW"), "zh-Hant");
  assert.equal(matchLocale("zh-HK"), "zh-Hant");
  assert.equal(matchLocale("zh-CN"), "zh-Hans");
  assert.equal(matchLocale("zh"), "zh-Hans");
});

test("an unsupported language is reported as no match", () => {
  assert.equal(matchLocale("ko"), null);
  assert.equal(matchLocale("th-TH"), null);
  assert.equal(matchLocale(""), null);
  assert.equal(matchLocale(null), null);
  assert.equal(matchLocale(undefined), null);
});

// The user's ordered preference list decides, not just the first entry.
test("detection walks the preference list", () => {
  assert.equal(detectLocale(["ko", "de-AT", "en"]), "de");
  assert.equal(detectLocale(["xx", "ja"]), "ja");
});

// A system in a language this build does not ship must still get a usable UI.
test("detection falls back to English when nothing matches", () => {
  assert.equal(detectLocale(["ko", "th"]), FALLBACK_LOCALE);
  assert.equal(detectLocale([]), FALLBACK_LOCALE);
  assert.equal(detectLocale(undefined), FALLBACK_LOCALE);
});

// --- metadata ---------------------------------------------------------------

test("every locale has a native name for the picker", () => {
  for (const locale of LOCALES) {
    const meta = LOCALE_META[locale];
    assert.ok(meta, `missing metadata for ${locale}`);
    assert.notEqual(meta.native.trim(), "");
    // The native name should be written in that language, not in English.
    if (locale !== "en") {
      assert.notEqual(meta.native, meta.english, `${locale} native name is the English one`);
    }
  }
});

test("isLocale accepts only shipped locales", () => {
  for (const locale of LOCALES) assert.ok(isLocale(locale));
  assert.ok(!isLocale("ko"));
  assert.ok(!isLocale(null));
  assert.ok(!isLocale(42));
});

// The picker must list every catalogue, or a language would be unreachable.
test("the locale list and the catalogue map agree", () => {
  assert.deepEqual(Object.keys(CATALOGUES).sort(), [...LOCALES].sort());
});
