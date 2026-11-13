#!/usr/bin/env node
// Renderer-side retained-heap benchmark for the 0003 IPC payload change.
//
// Reads the two payload files produced by
// `crates/litediff-core/examples/mem_bench.rs`, parses each in a **fresh child
// process**, forces GC twice before and after, and reports the retained
// `heapUsed` delta. A fresh process per payload is what keeps the two numbers
// independent: V8 never gets to reuse the first payload's pages for the second.
//
// When `app/src/lib/diffView.ts` exists (the 0003 renderer decoder), the
// compact measurement parses the wire object, runs `decodeDiff(wire)`, drops the
// wire object and keeps only the decoded `DiffTable`. That is the realistic
// renderer state: the JSON string and the parsed wire graph are transient, the
// typed-array table and hunk list stay resident for the tab's lifetime. Without
// the decoder the script falls back to a parse-only comparison and says so.
//
// Usage:
//   node --expose-gc scripts/frontend-memory-bench.mjs [--dir DIR]
//        [--legacy diff-legacy.json] [--compact diff-compact.json]
//        [--decode PATH]
//
// The script spawns its own children with `--expose-gc`, so passing the flag to
// the parent is only needed to satisfy the documented invocation; measurement
// always happens in a child that has it.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_DIR = path.join(REPO_ROOT, "target", "bench-out");
const DEFAULT_DECODE = path.join(REPO_ROOT, "app", "src", "lib", "diffView.ts");

const MIB = 1024 * 1024;

function fail(message) {
  console.error(`frontend-memory-bench: ${message}`);
  process.exit(2);
}

function parseArgs(argv) {
  const options = {
    dir: DEFAULT_DIR,
    legacy: "diff-legacy.json",
    compact: "diff-compact.json",
    decode: null,
    measure: null,
    file: null,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) fail(`${arg} needs a value`);
      index += 1;
      return argv[index];
    };
    switch (arg) {
      case "--dir":
        options.dir = path.resolve(next());
        break;
      case "--legacy":
        options.legacy = next();
        break;
      case "--compact":
        options.compact = next();
        break;
      case "--decode":
        options.decode = path.resolve(next());
        break;
      case "--measure":
        options.measure = next();
        break;
      case "--file":
        options.file = path.resolve(next());
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        fail(`unknown argument \`${arg}\` (try --help)`);
    }
  }
  return options;
}

function formatInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatMib(bytes) {
  return (bytes / MIB).toFixed(2);
}

function percentReduction(before, after) {
  if (!Number.isFinite(before) || before <= 0) return null;
  return ((before - after) / before) * 100;
}

function formatPercent(reduction) {
  return reduction === null ? "n/a" : `${reduction.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Child process: measure one payload in isolation.
// ---------------------------------------------------------------------------

async function measureOne({ format, file, decodePath }) {
  if (typeof global.gc !== "function") {
    fail("measurement requires node --expose-gc");
  }
  if (!existsSync(file)) fail(`payload file not found: ${file}`);

  // Load the JSON text before the baseline measurement: the transient IPC
  // string must not count towards the retained graph.
  const raw = readFileSync(file, "utf8");
  const jsonBytes = Buffer.byteLength(raw, "utf8");

  let decodeDiff = null;
  let decodeError = null;
  if (decodePath) {
    try {
      const module = await import(pathToFileURL(decodePath).href);
      if (typeof module.decodeDiff === "function") {
        decodeDiff = module.decodeDiff;
      } else {
        decodeError = "module has no decodeDiff export";
      }
    } catch (error) {
      decodeError = error instanceof Error ? error.message : String(error);
    }
  }

  global.gc();
  global.gc();
  const usageBefore = process.memoryUsage();

  const parseStarted = process.hrtime.bigint();
  let parsed = JSON.parse(raw);
  const parseMs = Number(process.hrtime.bigint() - parseStarted) / 1e6;

  let retained = parsed;
  let decodeMs = null;
  let retainedKind = "parsed JSON";
  if (decodeDiff) {
    const decodeStarted = process.hrtime.bigint();
    retained = decodeDiff(parsed);
    decodeMs = Number(process.hrtime.bigint() - decodeStarted) / 1e6;
    // The wire object is transient in the renderer; only the decoded table is
    // kept by the tab. Dropping it before GC is what makes the comparison fair.
    parsed = null;
    retainedKind = "parsed JSON + decodeDiff";
  }
  // Keep the retained graph alive across the GCs below.
  globalThis.__litediffRetained = retained;

  global.gc();
  global.gc();
  const usageAfter = process.memoryUsage();

  // `heapUsed` excludes the backing stores of typed arrays, which is exactly
  // where the compact table keeps its nine bytes per row (`Int32Array` /
  // `Uint8Array`). Count `arrayBuffers` too, otherwise the compact decoded
  // table would look smaller than it is: the point is resident memory, not
  // V8-heap-resident JS objects.
  const heapBytes = Math.max(0, usageAfter.heapUsed - usageBefore.heapUsed);
  const arrayBufferBytes = Math.max(
    0,
    (usageAfter.arrayBuffers ?? 0) - (usageBefore.arrayBuffers ?? 0),
  );
  const retainedBytes = heapBytes + arrayBufferBytes;

  const rows =
    typeof retained?.length === "number"
      ? retained.length
      : Array.isArray(retained?.rows)
        ? retained.rows.length
        : null;

  const result = {
    format,
    jsonBytes,
    heapBytes,
    arrayBufferBytes,
    retainedBytes,
    rows,
    parseMs,
    decodeMs,
    decodeError,
    retainedKind,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// ---------------------------------------------------------------------------
// Parent: drive one child per payload and print the comparison.
// ---------------------------------------------------------------------------

function measureInChild(format, file, decodePath) {
  const args = [
    "--expose-gc",
    SCRIPT_PATH,
    "--measure",
    format,
    "--file",
    file,
  ];
  if (decodePath) args.push("--decode", decodePath);

  const child = spawnSync(process.execPath, args, {
    encoding: "utf8",
    maxBuffer: 16 * MIB,
  });
  if (child.error) fail(`cannot spawn measurement child: ${child.error.message}`);
  if (child.status !== 0) {
    const stderr = (child.stderr || "").trim();
    fail(`measurement child failed for ${format}${stderr ? `: ${stderr}` : ""}`);
  }
  const lines = (child.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) fail(`measurement child for ${format} produced no output`);
  try {
    return JSON.parse(lines[lines.length - 1]);
  } catch (error) {
    fail(`cannot parse measurement child output for ${format}: ${error.message}`);
  }
}

function printUsage() {
  console.error(
    [
      "frontend-memory-bench — retained JS heap of the legacy vs compact diff payload",
      "",
      "USAGE:",
      "    node --expose-gc scripts/frontend-memory-bench.mjs [OPTIONS]",
      "",
      "OPTIONS:",
      "    --dir DIR        directory holding the mem_bench payloads",
      "                     (default target/bench-out)",
      "    --legacy NAME    legacy payload file name (default diff-legacy.json)",
      "    --compact NAME   compact payload file name (default diff-compact.json)",
      "    --decode PATH    decoder module (default app/src/lib/diffView.ts when present)",
      "    -h, --help       print this help",
    ].join("\n"),
  );
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  // Child mode: measure exactly one payload and exit.
  if (options.measure) {
    if (!options.file) fail("--measure requires --file");
    await measureOne({
      format: options.measure,
      file: options.file,
      decodePath: options.decode,
    });
    return;
  }

  if (options.help) {
    printUsage();
    return;
  }

  const legacyPath = path.resolve(options.dir, options.legacy);
  const compactPath = path.resolve(options.dir, options.compact);
  if (!existsSync(legacyPath)) fail(`legacy payload not found: ${legacyPath}`);
  if (!existsSync(compactPath)) fail(`compact payload not found: ${compactPath}`);

  const decodePath =
    options.decode ??
    (existsSync(DEFAULT_DECODE) ? DEFAULT_DECODE : null);
  const decodeAvailable = decodePath !== null;
  const decodeUsed = decodeAvailable ? decodePath : null;

  const legacy = measureInChild("legacy", legacyPath, null);
  const compact = measureInChild("compact", compactPath, decodeUsed);

  const decodeEnabled = compact.decodeMs !== null;
  const decodeNote = decodeEnabled
    ? "parse + decodeDiff"
    : compact.decodeError
      ? `decode skipped (${compact.decodeError})`
      : "decode skipped (diffView.ts not found)";

  console.log(`frontend heap benchmark (node ${process.version})`);
  console.log(`directory: ${options.dir}`);
  if (decodeEnabled) {
    console.log(`decode: enabled — ${decodeUsed}`);
  } else {
    console.log(`decode: disabled — ${decodeNote}`);
    if (decodeAvailable) {
      console.log("note: app/src/lib/diffView.ts is present, but the decoder could not be imported;");
      console.log("      the compact number below is parse-only and understates the renderer diff table.");
    } else {
      console.log("note: app/src/lib/diffView.ts does not exist yet; the compact number is parse-only.");
    }
  }
  console.log("");
  console.log(
    "| payload | JSON bytes | JSON MiB | heapUsed MiB | ArrayBuffer MiB | retained MiB | rows | parse ms | decode ms | retained |",
  );
  console.log("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const result of [legacy, compact]) {
    console.log(
      `| ${result.format} | ${formatInteger(result.jsonBytes)} | ${formatMib(result.jsonBytes)} | ${formatMib(result.heapBytes)} | ${formatMib(result.arrayBufferBytes)} | ${formatMib(result.retainedBytes)} | ${result.rows ?? "?"} | ${result.parseMs.toFixed(1)} | ${result.decodeMs === null ? "n/a" : result.decodeMs.toFixed(1)} | ${result.retainedKind} |`,
    );
  }
  console.log("");

  const jsonReduction = percentReduction(legacy.jsonBytes, compact.jsonBytes);
  const heapReduction = percentReduction(legacy.retainedBytes, compact.retainedBytes);
  console.log(
    `JSON bytes: ${formatInteger(legacy.jsonBytes)} → ${formatInteger(compact.jsonBytes)} (${formatPercent(jsonReduction)} smaller)`,
  );
  console.log(
    `retained memory: ${formatMib(legacy.retainedBytes)} MiB → ${formatMib(compact.retainedBytes)} MiB (${formatPercent(heapReduction)} smaller${decodeEnabled ? "" : ", parse-only comparison"})`,
  );
  console.log("");

  console.log(
    `js_heap format=legacy json_bytes=${legacy.jsonBytes} heap_bytes=${legacy.heapBytes} array_buffer_bytes=${legacy.arrayBufferBytes} retained_bytes=${legacy.retainedBytes} rows=${legacy.rows ?? "null"}`,
  );
  console.log(
    `js_heap format=compact json_bytes=${compact.jsonBytes} heap_bytes=${compact.heapBytes} array_buffer_bytes=${compact.arrayBufferBytes} retained_bytes=${compact.retainedBytes} rows=${compact.rows ?? "null"} decode=${decodeEnabled ? "enabled" : "disabled"}`,
  );
  console.log(
    `js_heap json_reduction_pct=${jsonReduction === null ? "null" : jsonReduction.toFixed(1)} retained_reduction_pct=${heapReduction === null ? "null" : heapReduction.toFixed(1)}`,
  );

  if (legacy.rows !== null && compact.rows !== null && legacy.rows !== compact.rows) {
    console.log(
      `warning: row count mismatch between payloads (legacy ${legacy.rows}, compact ${compact.rows})`,
    );
  }
}

await main();
