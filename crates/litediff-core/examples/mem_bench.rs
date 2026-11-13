//! Memory / latency benchmark harness for the dense-diff envelope.
//!
//! Generates a deterministic synthetic comparison at the product's document
//! ceiling (200,000 lines, ~16 MiB per side), runs [`litediff_core::diff`], then
//! materialises the two IPC payload shapes that 0003 compares:
//!
//! * **legacy** — the pre-change `DiffResult` JSON: one object per aligned row,
//!   each carrying `left`/`right`/`kind` plus two (usually empty) inline-segment
//!   arrays, and for modified rows the full text copied into `InlineSegment`s.
//!   The shape is byte-for-byte what `serde_json` produces for
//!   [`litediff_core::DiffResult`], field order included.
//! * **compact** — the 0003 IPC v2 payload from
//!   `specs/changes/0003-lower-runtime-memory/plan.md` §2: hunk table, stats,
//!   `approximate`, and the changed `(row, start, end)` UTF-16 triples for the
//!   two sides. Numeric-only, so it equals `serde_json`'s output for
//!   `crates/litediff-app/src/wire.rs`'s `WireDiff`.
//!
//! Why an example instead of a test: the numbers that matter are process-level
//! (`maxrss`, payload file size), so an external driver
//! (`scripts/bench-memory.sh`, `scripts/frontend-memory-bench.mjs`) has to run
//! the program and inspect its output. The crate itself stays dependency-free,
//! so the JSON is written by hand with `std::fmt::Write` only.
//!
//! ## Usage
//!
//! ```text
//! cargo run -p litediff-core --release --example mem_bench -- \
//!     [--lines N] [--mode legacy|compact|both] [--out DIR] \
//!     [--modify-every K] [--json-alloc grow|exact]
//! ```
//!
//! * `--lines` — number of synthetic source lines per side (default 200000).
//! * `--mode` — which payload(s) to materialise (default `both`).
//! * `--out` — directory for `diff-legacy.json` / `diff-compact.json`
//!   (default `target/bench-out`).
//! * `--modify-every` — every K-th line differs on the right side (default 50;
//!   `0` produces identical documents).
//! * `--json-alloc` — `grow` (default) lets the payload `String` grow exactly
//!   like `serde_json`'s serializing buffer; `exact` pre-measures the payload
//!   and allocates once, which is useful to quantify how much of `maxrss` is the
//!   serializing buffer's doubling growth.
//!
//! Output: one machine-readable `key=value` line per payload for the driver to
//! parse, plus the payload files themselves. `maxrss` and JS heap are measured
//! by the drivers, not here.

use std::env;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;
use std::time::Instant;

use litediff_core::{
    diff_sources, AlignedRow, DiffOptions, DiffResult, DiffStats, Hunk, InlineSegment, RowKind,
    SourceText,
};

/// Default number of source lines per side: the product's document ceiling.
const DEFAULT_LINES: usize = 200_000;
/// Default modification stride: ~1000 single-line edits over 200k lines. Dense
/// enough to exercise thousands of hunks and changed ranges, sparse enough that
/// the line-level Myers search stays well inside its 25M work budget (a stride
/// of 50 makes the 200k-line diff exhaust the budget and go approximate).
const DEFAULT_MODIFY_EVERY: usize = 200;
/// Rough bytes per generated line, used to reserve the source buffers.
const LINE_RESERVE: usize = 96;

fn main() {
    match run() {
        Ok(()) => {}
        Err(message) => {
            eprintln!("mem_bench: {message}");
            process::exit(1);
        }
    }
}

fn run() -> Result<(), String> {
    let args = Args::parse()?;

    // ---- deterministic synthetic input ------------------------------------
    let generation_started = Instant::now();
    let (left_text, right_text) = generate_documents(args.lines, args.modify_every);
    let generation_ms = elapsed_ms(generation_started);
    let left_bytes = left_text.len();
    let right_bytes = right_text.len();

    // The desktop app keeps one indexed copy of each side (`SourceText` shares
    // its buffer with the session), so the harness charges itself one indexed
    // copy per document rather than an extra text copy per side.
    let left = SourceText::new(left_text);
    let right = SourceText::new(right_text);

    // ---- the thing under test ---------------------------------------------
    let diff_started = Instant::now();
    let result = diff_sources(&left, &right, &DiffOptions::default());
    let diff_ms = elapsed_ms(diff_started);

    fs::create_dir_all(&args.out)
        .map_err(|error| format!("cannot create {}: {error}", args.out.display()))?;

    let context = format!(
        "lines={} left_bytes={} right_bytes={} rows={} hunks={} modified={} deleted={} added={} approximate={} generation_ms={generation_ms:.1} diff_ms={diff_ms:.1} json_alloc={}",
        args.lines,
        left_bytes,
        right_bytes,
        result.rows.len(),
        result.hunks.len(),
        result.stats.modified,
        result.stats.deleted,
        result.stats.added,
        result.approximate,
        args.alloc.as_str(),
    );

    if matches!(args.mode, Mode::Legacy | Mode::Both) {
        let build_started = Instant::now();
        let json = render_json(args.alloc, |out| write_legacy(out, &result));
        let build_ms = elapsed_ms(build_started);
        let path = write_payload(&args.out, "diff-legacy.json", &json)?;
        println!(
            "mode=legacy {context} build_ms={build_ms:.1} json_bytes={} json_mib={:.2} json_path={}",
            json.len(),
            mib(json.len()),
            path.display(),
        );
    }

    if matches!(args.mode, Mode::Compact | Mode::Both) {
        let build_started = Instant::now();
        let json = render_json(args.alloc, |out| write_compact(out, &result));
        let build_ms = elapsed_ms(build_started);
        let path = write_payload(&args.out, "diff-compact.json", &json)?;
        println!(
            "mode=compact {context} build_ms={build_ms:.1} json_bytes={} json_mib={:.2} json_path={}",
            json.len(),
            mib(json.len()),
            path.display(),
        );
    }

    Ok(())
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

fn mib(bytes: usize) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    Legacy,
    Compact,
    Both,
}

impl Mode {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "legacy" => Ok(Self::Legacy),
            "compact" => Ok(Self::Compact),
            "both" => Ok(Self::Both),
            other => Err(format!(
                "--mode: `{other}` is not one of legacy, compact, both"
            )),
        }
    }
}

/// How the payload [`String`] is allocated.
///
/// `serde_json` serializes into a fresh buffer that doubles as it grows, so the
/// final capacity can be up to 2x the payload length and the last reallocation
/// briefly holds the old and new buffers at the same time. `grow` reproduces
/// that (the default, and the realistic baseline shape); `exact` pre-measures
/// the payload with a counting writer and allocates once, which isolates the
/// algorithm's memory from the serializer's allocation pattern.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum JsonAlloc {
    Grow,
    Exact,
}

impl JsonAlloc {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "grow" => Ok(Self::Grow),
            "exact" => Ok(Self::Exact),
            other => Err(format!("--json-alloc: `{other}` is not one of grow, exact")),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Grow => "grow",
            Self::Exact => "exact",
        }
    }
}

#[derive(Debug)]
struct Args {
    lines: usize,
    mode: Mode,
    out: PathBuf,
    modify_every: usize,
    alloc: JsonAlloc,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut args = env::args().skip(1);
        let mut parsed = Self {
            lines: DEFAULT_LINES,
            mode: Mode::Both,
            out: PathBuf::from("target/bench-out"),
            modify_every: DEFAULT_MODIFY_EVERY,
            alloc: JsonAlloc::Grow,
        };

        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--lines" => parsed.lines = parse_usize(&mut args, "--lines")?,
                "--mode" => parsed.mode = Mode::parse(&next_value(&mut args, "--mode")?)?,
                "--out" => parsed.out = PathBuf::from(next_value(&mut args, "--out")?),
                "--modify-every" => parsed.modify_every = parse_usize(&mut args, "--modify-every")?,
                "--json-alloc" => {
                    parsed.alloc = JsonAlloc::parse(&next_value(&mut args, "--json-alloc")?)?
                }
                "--help" | "-h" => {
                    print_usage();
                    process::exit(0);
                }
                other => return Err(format!("unknown argument `{other}` (try --help)")),
            }
        }

        if parsed.lines == 0 {
            return Err("--lines must be at least 1".to_owned());
        }
        Ok(parsed)
    }
}

fn next_value(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<String, String> {
    args.next()
        .ok_or_else(|| format!("{flag} needs a value (try --help)"))
}

fn parse_usize(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<usize, String> {
    let value = next_value(args, flag)?;
    value
        .parse::<usize>()
        .map_err(|_| format!("{flag}: `{value}` is not a non-negative integer"))
}

fn print_usage() {
    eprintln!(
        "mem_bench — deterministic memory/latency benchmark for the dense-diff envelope\n\
         \n\
         USAGE:\n\
             cargo run -p litediff-core --release --example mem_bench -- [OPTIONS]\n\
         \n\
         OPTIONS:\n\
             --lines N            lines per side (default {DEFAULT_LINES})\n\
             --mode MODE          legacy | compact | both (default both)\n\
             --out DIR            payload output dir (default target/bench-out)\n\
             --modify-every K     every K-th right line differs (default {DEFAULT_MODIFY_EVERY}; 0 = identical)\n\
             --json-alloc MODE    grow | exact (default grow; exact pre-measures the buffer)\n\
             -h, --help           print this help"
    );
}

// ---------------------------------------------------------------------------
// Deterministic synthetic documents
// ---------------------------------------------------------------------------

/// One left-side line.
///
/// `i` appears in several places, so nearly every line is unique and the line
/// interner has one entry per line — the memory pressure this benchmark is
/// about. Repeated `i % 997` idents keep the intra-line token diff cheap and
/// realistic rather than one giant always-unmatched token.
fn line(i: usize) -> String {
    format!(
        "let cached_value_{i} = compute_{}(cursor, 0x{i:x}) + compute_{}(cursor, 0x{:x});",
        i % 997,
        (i * 7) % 991,
        i ^ 0x5a5a
    )
}

/// The right-side counterpart of [`line`]: a small in-line change (one literal)
/// so the row becomes a `Modify` with one changed UTF-16 range per side.
fn modified_line(i: usize) -> String {
    format!(
        "let cached_value_{i} = compute_{}(cursor, 0x{i:x}) + compute_{}(cursor, 0x{:x});",
        i % 997,
        (i * 7) % 991,
        (i ^ 0x5a5a) + 1
    )
}

/// A line that exists only on the right side, used for the structural changes.
fn inserted_line(i: usize) -> String {
    format!("let inserted_{i} = compute_{}(cursor, 0x{i:x});", i % 991)
}

/// Two single-line deletions and one single-line insertion, positioned relative
/// to the document length so they scale from smoke-test fixtures to 200k lines.
/// They exercise `Delete`/`Insert` rows (padded cells) instead of only paired
/// `Modify` rows.
fn is_deleted_at(lines: usize, index: usize) -> bool {
    index > 0 && (index == lines / 4 || index == lines * 3 / 4)
}

fn is_inserted_at(lines: usize, index: usize) -> bool {
    index > 0 && index == lines / 2
}

fn generate_documents(lines: usize, modify_every: usize) -> (String, String) {
    let mut left = String::with_capacity(lines.saturating_mul(LINE_RESERVE));
    for index in 0..lines {
        left.push_str(&line(index));
        left.push('\n');
    }

    let mut right = String::with_capacity(left.len());
    for index in 0..lines {
        if is_deleted_at(lines, index) {
            continue;
        }
        if is_inserted_at(lines, index) {
            right.push_str(&inserted_line(index));
            right.push('\n');
        }
        if is_multiple_of(index, modify_every) {
            right.push_str(&modified_line(index));
        } else {
            right.push_str(&line(index));
        }
        right.push('\n');
    }

    (left, right)
}

/// `index % stride == 0`, spelled out because the workspace MSRV (1.75) predates
/// `usize::is_multiple_of` (stable since 1.87).
#[allow(clippy::manual_is_multiple_of)]
fn is_multiple_of(index: usize, stride: usize) -> bool {
    stride > 0 && index % stride == 0
}

// ---------------------------------------------------------------------------
// JSON rendering
//
// The two payload writers mirror the `serde` derives on the core types: field
// order, snake_case names, `null` for the padded side and lower-case `RowKind`
// strings. `stdlib` only — the core crate has no dependencies by design.
// ---------------------------------------------------------------------------

/// Budget the caller gives the JSON render: either a real `String` or the
/// counting sink used to pre-measure the payload for `--json-alloc exact`.
trait JsonSink: fmt::Write {}

impl JsonSink for String {}
impl JsonSink for Counting {}

/// A `fmt::Write` sink that only counts the bytes it would have received.
#[derive(Default)]
struct Counting(usize);

impl fmt::Write for Counting {
    fn write_str(&mut self, value: &str) -> fmt::Result {
        self.0 += value.len();
        Ok(())
    }

    fn write_char(&mut self, value: char) -> fmt::Result {
        self.0 += value.len_utf8();
        Ok(())
    }
}

fn render_json(alloc: JsonAlloc, render: impl Fn(&mut dyn JsonSink) -> fmt::Result) -> String {
    match alloc {
        JsonAlloc::Grow => {
            let mut out = String::new();
            render(&mut out).expect("writing JSON into a String cannot fail");
            out
        }
        JsonAlloc::Exact => {
            let mut counter = Counting::default();
            render(&mut counter).expect("counting JSON bytes cannot fail");
            let mut out = String::with_capacity(counter.0);
            render(&mut out).expect("writing JSON into a String cannot fail");
            debug_assert_eq!(
                out.len(),
                counter.0,
                "payload length must be measured exactly"
            );
            out
        }
    }
}

fn write_payload(out_dir: &Path, name: &str, json: &str) -> Result<PathBuf, String> {
    let path = out_dir.join(name);
    fs::write(&path, json).map_err(|error| format!("cannot write {}: {error}", path.display()))?;
    Ok(path)
}

fn write_bool<W: JsonSink + ?Sized>(out: &mut W, value: bool) -> fmt::Result {
    out.write_str(if value { "true" } else { "false" })
}

fn write_opt_u32<W: JsonSink + ?Sized>(out: &mut W, value: Option<u32>) -> fmt::Result {
    match value {
        Some(number) => write!(out, "{number}"),
        None => out.write_str("null"),
    }
}

/// Write `value` as a JSON string, escaping exactly like `serde_json` (short
/// escapes for `\b \f \n \r \t`, `\u00xx` for other control characters, UTF-8
/// passed through for everything else).
fn write_json_string<W: JsonSink + ?Sized>(out: &mut W, value: &str) -> fmt::Result {
    out.write_char('"')?;
    for character in value.chars() {
        match character {
            '"' => out.write_str("\\\"")?,
            '\\' => out.write_str("\\\\")?,
            '\u{08}' => out.write_str("\\b")?,
            '\u{0c}' => out.write_str("\\f")?,
            '\n' => out.write_str("\\n")?,
            '\r' => out.write_str("\\r")?,
            '\t' => out.write_str("\\t")?,
            control if (control as u32) < 0x20 => {
                write!(out, "\\u{:04x}", control as u32)?;
            }
            other => out.write_char(other)?,
        }
    }
    out.write_char('"')
}

fn kind_name(kind: RowKind) -> &'static str {
    match kind {
        RowKind::Equal => "equal",
        RowKind::Modify => "modify",
        RowKind::Delete => "delete",
        RowKind::Insert => "insert",
    }
}

fn write_stats<W: JsonSink + ?Sized>(out: &mut W, stats: &DiffStats) -> fmt::Result {
    let DiffStats {
        added,
        deleted,
        modified,
        unchanged,
    } = *stats;
    write!(
        out,
        "{{\"added\":{added},\"deleted\":{deleted},\"modified\":{modified},\"unchanged\":{unchanged}}}"
    )
}

fn write_hunk<W: JsonSink + ?Sized>(out: &mut W, hunk: &Hunk) -> fmt::Result {
    let Hunk {
        equal,
        left_start,
        left_len,
        right_start,
        right_len,
        row_start,
        row_len,
    } = *hunk;
    write!(
        out,
        "{{\"equal\":{equal},\"left_start\":{left_start},\"left_len\":{left_len},\"right_start\":{right_start},\"right_len\":{right_len},\"row_start\":{row_start},\"row_len\":{row_len}}}"
    )
}

fn write_segments<W: JsonSink + ?Sized>(out: &mut W, segments: &[InlineSegment]) -> fmt::Result {
    out.write_char('[')?;
    for (index, segment) in segments.iter().enumerate() {
        if index > 0 {
            out.write_char(',')?;
        }
        out.write_str("{\"text\":")?;
        write_json_string(out, &segment.text)?;
        let char_start = segment.char_start;
        let char_end = segment.char_end;
        let changed = segment.changed;
        write!(
            out,
            ",\"char_start\":{char_start},\"char_end\":{char_end},\"changed\":{changed}}}"
        )?;
    }
    out.write_char(']')
}

fn write_row<W: JsonSink + ?Sized>(out: &mut W, row: &AlignedRow) -> fmt::Result {
    out.write_str("{\"left\":")?;
    write_opt_u32(out, row.left)?;
    out.write_str(",\"right\":")?;
    write_opt_u32(out, row.right)?;
    write!(
        out,
        ",\"kind\":\"{}\",\"left_inline\":",
        kind_name(row.kind)
    )?;
    write_segments(out, &row.left_inline)?;
    out.write_str(",\"right_inline\":")?;
    write_segments(out, &row.right_inline)?;
    out.write_char('}')
}

/// The pre-0003 `DiffResult` payload, field order identical to its `serde`
/// derive: `left_line_count`, `right_line_count`, `rows`, `hunks`, `stats`,
/// `approximate`.
fn write_legacy<W: JsonSink + ?Sized>(out: &mut W, result: &DiffResult) -> fmt::Result {
    let left_line_count = result.left_line_count;
    let right_line_count = result.right_line_count;
    write!(
        out,
        "{{\"left_line_count\":{left_line_count},\"right_line_count\":{right_line_count},\"rows\":["
    )?;
    for (index, row) in result.rows.iter().enumerate() {
        if index > 0 {
            out.write_char(',')?;
        }
        write_row(out, row)?;
    }
    out.write_str("],\"hunks\":[")?;
    for (index, hunk) in result.hunks.iter().enumerate() {
        if index > 0 {
            out.write_char(',')?;
        }
        write_hunk(out, hunk)?;
    }
    out.write_str("],\"stats\":")?;
    write_stats(out, &result.stats)?;
    out.write_str(",\"approximate\":")?;
    write_bool(out, result.approximate)?;
    out.write_char('}')
}

#[derive(Clone, Copy)]
enum Side {
    Left,
    Right,
}

/// Append the flat `(row, start, end)` triples of changed runs.
///
/// Offsets are UTF-16 code units summed from the segment texts, exactly like
/// `crates/litediff-app/src/wire.rs` does on the way to the renderer, so the
/// payload is byte-identical to the real serialized `WireDiff` (it carries no
/// strings, only numbers and booleans).
fn write_changed<W: JsonSink + ?Sized>(
    out: &mut W,
    result: &DiffResult,
    side: Side,
) -> fmt::Result {
    out.write_char('[')?;
    let mut first = true;
    for (index, row) in result.rows.iter().enumerate() {
        if row.kind != RowKind::Modify {
            continue;
        }
        let segments = match side {
            Side::Left => &row.left_inline,
            Side::Right => &row.right_inline,
        };
        let mut offset: u32 = 0;
        for segment in segments {
            let utf16_len = segment.text.encode_utf16().count() as u32;
            if segment.changed {
                let row_index = index as u32;
                let start = offset;
                let end = offset + utf16_len;
                if first {
                    first = false;
                } else {
                    out.write_char(',')?;
                }
                write!(out, "{row_index},{start},{end}")?;
            }
            offset += utf16_len;
        }
    }
    out.write_char(']')
}

/// The 0003 IPC v2 payload from `plan.md` §2: hunks + stats + approximate + the
/// two changed-range triple arrays. `rows` is not sent; the renderer re-derives
/// the grid from `hunks`.
fn write_compact<W: JsonSink + ?Sized>(out: &mut W, result: &DiffResult) -> fmt::Result {
    let left_line_count = result.left_line_count;
    let right_line_count = result.right_line_count;
    write!(
        out,
        "{{\"left_line_count\":{left_line_count},\"right_line_count\":{right_line_count},\"hunks\":["
    )?;
    for (index, hunk) in result.hunks.iter().enumerate() {
        if index > 0 {
            out.write_char(',')?;
        }
        write_hunk(out, hunk)?;
    }
    out.write_str("],\"stats\":")?;
    write_stats(out, &result.stats)?;
    out.write_str(",\"approximate\":")?;
    write_bool(out, result.approximate)?;
    out.write_str(",\"left_changed\":")?;
    write_changed(out, result, Side::Left)?;
    out.write_str(",\"right_changed\":")?;
    write_changed(out, result, Side::Right)?;
    out.write_char('}')
}
