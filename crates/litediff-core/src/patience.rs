//! Patience diff.
//!
//! Plain Myers produces minimal edit scripts, which on real refactors often
//! looks like "half the file changed" because it happily matches a `}` on line 3
//! against a `}` on line 400. Patience diff trades minimality for readability:
//!
//! 1. Count how often each symbol occurs in both regions.
//! 2. Keep only symbols occurring **exactly once** on *each* side. Those are
//!    unambiguous anchors.
//! 3. Find the longest increasing run of paired anchors (their left and right
//!    positions must both ascend) — the patience step, an LIS over pairs.
//! 4. Recurse into the gaps; regions with no anchors fall back to Myers.
//!
//! Step 3 is what makes the output stable: unique lines are almost never
//! coincidental, so they pin the alignment exactly where a human would.

use std::collections::HashMap;

use crate::myers;

/// Compute matched `(left, right)` pairs using patience anchoring.
///
/// Returns ascending pairs, but *not* guaranteed minimal: readability is the
/// objective here. The paired anchors themselves are a valid common
/// subsequence, so correctness (equal symbols at matched indices) holds.
pub fn matches(a: &[u32], b: &[u32]) -> Vec<(u32, u32)> {
    let mut out = Vec::with_capacity(a.len().min(b.len()));
    let mut stack = vec![(0usize, a.len(), 0usize, b.len())];

    while let Some((mut a_lo, mut a_hi, mut b_lo, mut b_hi)) = stack.pop() {
        while a_lo < a_hi && b_lo < b_hi && a[a_lo] == b[b_lo] {
            out.push((a_lo as u32, b_lo as u32));
            a_lo += 1;
            b_lo += 1;
        }
        while a_lo < a_hi && b_lo < b_hi && a[a_hi - 1] == b[b_hi - 1] {
            a_hi -= 1;
            b_hi -= 1;
            out.push((a_hi as u32, b_hi as u32));
        }

        if a_lo >= a_hi || b_lo >= b_hi {
            continue;
        }

        let anchors = unique_anchors(&a[a_lo..a_hi], &b[b_lo..b_hi]);

        if anchors.is_empty() {
            // No unambiguous lines: fall back to the minimal algorithm.
            for (i, j) in myers::matches(&a[a_lo..a_hi], &b[b_lo..b_hi]) {
                out.push((a_lo as u32 + i, b_lo as u32 + j));
            }
            continue;
        }

        // Emit the anchors and queue the four surrounding gaps. Ordering does
        // not matter here because the result is sorted by the caller, but the
        // gaps must be expressed in absolute coordinates.
        let mut prev_a = a_lo;
        let mut prev_b = b_lo;
        for (ai, bi) in anchors {
            let (abs_a, abs_b) = (a_lo + ai, b_lo + bi);
            stack.push((prev_a, abs_a, prev_b, abs_b));
            out.push((abs_a as u32, abs_b as u32));
            prev_a = abs_a + 1;
            prev_b = abs_b + 1;
        }
        stack.push((prev_a, a_hi, prev_b, b_hi));
    }

    out.sort_unstable();
    out
}

/// Return the longest ascending chain of lines that are unique on both sides.
///
/// The returned pairs are region-local and strictly ascending in both
/// coordinates.
fn unique_anchors(a: &[u32], b: &[u32]) -> Vec<(usize, usize)> {
    // One pass over each side; `unique` keeps only symbols seen exactly once.
    #[derive(Clone, Copy)]
    struct Seen {
        a_count: u32,
        b_count: u32,
        a_pos: usize,
        b_pos: usize,
    }

    let mut seen: HashMap<u32, Seen> = HashMap::new();
    for (i, &v) in a.iter().enumerate() {
        let e = seen.entry(v).or_insert(Seen {
            a_count: 0,
            b_count: 0,
            a_pos: i,
            b_pos: usize::MAX,
        });
        e.a_count += 1;
        e.a_pos = i;
    }
    for (j, &v) in b.iter().enumerate() {
        if let Some(e) = seen.get_mut(&v) {
            e.b_count += 1;
            e.b_pos = j;
        }
    }

    let mut pairs: Vec<(usize, usize)> = seen
        .values()
        .filter(|e| e.a_count == 1 && e.b_count == 1)
        .map(|e| (e.a_pos, e.b_pos))
        .collect();
    pairs.sort_unstable();

    if pairs.len() < 2 {
        return pairs;
    }

    longest_increasing_chain(&pairs)
}

/// Longest strictly-increasing chain in the second coordinate of `pairs`
/// (already sorted by the first coordinate). Classic O(n log n) patience
/// sorting with `tails` plus parent links for reconstruction.
fn longest_increasing_chain(pairs: &[(usize, usize)]) -> Vec<(usize, usize)> {
    // tails[i] = index into pairs of the smallest tail of an ascending run of
    // length i + 1.
    let mut tails: Vec<usize> = Vec::new();
    let mut parent: Vec<usize> = vec![usize::MAX; pairs.len()];

    for (i, &(_, bi)) in pairs.iter().enumerate() {
        let pos = tails.partition_point(|&t| pairs[t].1 < bi);
        if pos > 0 {
            parent[i] = tails[pos - 1];
        }
        if pos == tails.len() {
            tails.push(i);
        } else {
            tails[pos] = i;
        }
    }

    let mut chain = Vec::with_capacity(tails.len());
    let mut cur = *tails.last().expect("pairs is non-empty");
    loop {
        chain.push(pairs[cur]);
        if parent[cur] == usize::MAX {
            break;
        }
        cur = parent[cur];
    }
    chain.reverse();
    chain
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(a: &[u32], b: &[u32]) {
        let got = matches(a, b);
        for w in got.windows(2) {
            assert!(w[0].0 < w[1].0 && w[0].1 < w[1].1, "ascending: {got:?}");
        }
        for &(i, j) in &got {
            assert_eq!(a[i as usize], b[j as usize]);
        }
        // Sanity: at least as many matches as a trivial common prefix.
    }

    #[test]
    fn empty_and_trivial() {
        assert!(matches(&[], &[]).is_empty());
        assert!(matches(&[1], &[2]).is_empty());
        check(&[1, 2, 3], &[1, 2, 3]);
    }

    #[test]
    fn unique_lines_anchor_the_alignment() {
        // The repeated `}` symbols are deliberately ambiguous; `fn b` is the
        // unique anchor that should pin the alignment.
        let a = [9, 9, 20, 9, 9];
        let b = [9, 9, 9, 20, 9];
        check(&a, &b);
    }

    #[test]
    fn anchors_lis_keeps_one_per_unique_symbol() {
        // Region-local: a = [10, 11], b = [11, 10]. Both symbols unique in both
        // sides; the LIS keeps exactly one of them.
        let anchors = unique_anchors(&[10, 11], &[11, 10]);
        assert_eq!(anchors.len(), 1, "cannot keep both, order conflicts: {anchors:?}");
    }

    #[test]
    fn symbols_repeated_on_one_side_are_not_anchors() {
        let anchors = unique_anchors(&[10, 10, 11], &[10, 11]);
        assert_eq!(anchors, vec![(2, 1)], "10 is ambiguous on the left");
    }

    #[test]
    fn falls_back_to_myers_without_anchors() {
        let a = [1u32, 1, 1, 1];
        let b = [1u32, 1];
        let got = matches(&a, &b);
        assert_eq!(got, vec![(0, 0), (1, 1)]);
    }

    #[test]
    fn matches_myers_count_on_realistic_input() {
        // A file with a moved function: patience should still align the tail.
        let a: Vec<u32> = vec![1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
        let b: Vec<u32> = vec![5, 6, 7, 8, 9, 10, 1, 2, 3, 4];
        check(&a, &b);
    }

    #[test]
    fn longest_increasing_chain_is_maximal() {
        let pairs = [(0, 5), (1, 1), (2, 2), (3, 9), (4, 3)];
        let chain = longest_increasing_chain(&pairs);
        assert_eq!(chain, vec![(1, 1), (2, 2), (4, 3)]);
    }

    #[test]
    fn single_pair_chain() {
        let pairs = [(0usize, 7usize)];
        assert_eq!(longest_increasing_chain(&pairs), vec![(0, 7)]);
    }
}
