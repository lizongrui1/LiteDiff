//! Byte-accurate line model.
//!
//! Lines are stored as byte ranges into the original buffer, so the editor can
//! later overwrite exactly one line without re-serialising the document, and a
//! save (`Cmd + S`) writes back the buffer it read.

/// One line: `text[start..end]` is the line content *without* its terminator.
///
/// Line endings are normalised away at this layer: both `\n` and `\r\n`
/// terminate a line and the `\r` is excluded from the range. This makes EOL
/// differences invisible to the diff, which is what a review tool wants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Line {
    pub index: u32,
    pub start: u32,
    pub end: u32,
}

/// An immutable document plus its line index.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SourceText {
    text: String,
    lines: Vec<Line>,
}

impl SourceText {
    pub fn new(text: impl Into<String>) -> Self {
        let text = text.into();
        let lines = split_lines(&text);
        Self { text, lines }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn lines(&self) -> &[Line] {
        &self.lines
    }

    pub fn line_count(&self) -> u32 {
        self.lines.len() as u32
    }

    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }

    /// Content of line `index`, terminator excluded.
    ///
    /// # Panics
    /// Panics if `index` is out of range; callers hold indices produced by this
    /// same document.
    pub fn line_str(&self, index: u32) -> &str {
        let l = &self.lines[index as usize];
        &self.text[l.start as usize..l.end as usize]
    }

    /// All lines as string slices, in order.
    pub fn line_strs(&self) -> impl Iterator<Item = &str> + '_ {
        self.lines
            .iter()
            .map(move |l| &self.text[l.start as usize..l.end as usize])
    }
}

/// Split `text` into line ranges.
///
/// Semantics match git and every mainstream editor:
/// * an empty document has zero lines;
/// * a trailing terminator does not produce a phantom final line;
/// * a `\r` immediately before `\n` belongs to the terminator.
fn split_lines(text: &str) -> Vec<Line> {
    if text.is_empty() {
        return Vec::new();
    }
    let bytes = text.as_bytes();
    let mut lines = Vec::new();
    let mut start = 0usize;
    let mut index = 0u32;

    for (i, &b) in bytes.iter().enumerate() {
        if b == b'\n' {
            let mut end = i;
            if end > start && bytes[end - 1] == b'\r' {
                end -= 1;
            }
            lines.push(Line {
                index,
                start: start as u32,
                end: end as u32,
            });
            index += 1;
            start = i + 1;
        }
    }
    if start < bytes.len() {
        lines.push(Line {
            index,
            start: start as u32,
            end: bytes.len() as u32,
        });
    }
    lines
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_document_has_no_lines() {
        let s = SourceText::new("");
        assert_eq!(s.line_count(), 0);
        assert!(s.is_empty());
    }

    #[test]
    fn trailing_newline_is_not_a_phantom_line() {
        let s = SourceText::new("a\nb\n");
        assert_eq!(s.line_strs().collect::<Vec<_>>(), vec!["a", "b"]);
    }

    #[test]
    fn missing_trailing_newline_keeps_last_line() {
        let s = SourceText::new("a\nb");
        assert_eq!(s.line_strs().collect::<Vec<_>>(), vec!["a", "b"]);
    }

    #[test]
    fn crlf_terminator_is_stripped() {
        let s = SourceText::new("a\r\nb\r\n");
        assert_eq!(s.line_strs().collect::<Vec<_>>(), vec!["a", "b"]);
        assert_eq!(s.line_str(1), "b");
    }

    #[test]
    fn lone_cr_inside_line_is_content() {
        let s = SourceText::new("a\rb");
        assert_eq!(s.line_str(0), "a\rb");
    }

    #[test]
    fn blank_lines_are_preserved() {
        let s = SourceText::new("a\n\nb\n");
        assert_eq!(s.line_strs().collect::<Vec<_>>(), vec!["a", "", "b"]);
    }

    #[test]
    fn byte_ranges_are_valid_utf8_boundaries() {
        let s = SourceText::new("héllo\n世界\n");
        for l in s.lines() {
            assert!(!s.line_str(l.index).is_empty());
        }
        assert_eq!(s.line_str(0), "héllo");
        assert_eq!(s.line_str(1), "世界");
    }
}
