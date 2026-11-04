//! Myers O(ND) diff, linear-space "bisect" variant.
//!
//! This is the workhorse: it is used directly for `LineAlgorithm::Myers`, and as
//! the fallback inside patience diff for regions with no anchor lines.
//!
//! ## Coordinate conventions
//!
//! Work is local to the region being solved: `x` indexes the left slice, `y` the
//! right slice, `N`/`M` are the region sizes, and a *diagonal* is `k = x - y`,
//! so a point on diagonal `k` is `(x, x - k)`.
//!
//! The forward search records, in `vf`, the furthest `x` reachable after `d`
//! edits on each diagonal. The backward search runs on the *reversed* slices and
//! records the furthest reversed `x'` in `vb`. A reversed point `(x', y')` is
//! `(N - x', M - y')` in forward coordinates, so its reversed diagonal
//! `t = x' - y'` relates to the forward diagonal by `k = delta - t` where
//! `delta = N - M`. When the two frontiers meet (`x >= N - x'`) the meeting point
//! lies on an optimal edit path, so recursing on the two halves preserves
//! minimality. That is the whole trick, and the forward/backward diagonal
//! mapping `t = delta - k` is the only subtle part.
//!
//! ## Termination
//!
//! Callers peel the common prefix and suffix before bisecting, so a region
//! reaching `bisect` starts and ends on a mismatch. Consequently the split point
//! is always strictly interior and each half is strictly smaller than the
//! region, which is what makes the iterative work-stack version terminate.

/// Reusable furthest-x tables, sized once per `matches` call and reused for
/// every region of that call to keep the allocator out of the hot loop.
#[derive(Default)]
struct Frontiers {
    vf: Vec<isize>,
    vb: Vec<isize>,
}

impl Frontiers {
    /// Reset both tables to `-1` (unreachable) for a search bounded by `max_d`
    /// and seed the origin. Returns the index offset for diagonal 0.
    fn prepare(&mut self, max_d: isize) -> isize {
        let len = (2 * max_d + 3) as usize;
        self.vf.clear();
        self.vf.resize(len, -1);
        self.vb.clear();
        self.vb.resize(len, -1);
        let off = max_d + 1;
        self.vf[(off + 1) as usize] = 0;
        self.vb[(off + 1) as usize] = 0;
        off
    }
}

/// A region of work: left slice `[a_lo, a_hi)`, right slice `[b_lo, b_hi)`.
type Region = (usize, usize, usize, usize);

/// Compute matched `(left_index, right_index)` pairs between `a` and `b`.
///
/// The result is ascending in both coordinates and describes a shortest edit
/// script: `a.len() + b.len() - 2 * matches.len()` equals the edit distance
/// (verified against a DP LCS oracle in the tests below).
pub fn matches(a: &[u32], b: &[u32]) -> Vec<(u32, u32)> {
    if a.is_empty() || b.is_empty() {
        return Vec::new();
    }

    let mut frontiers = Frontiers::default();
    let mut out: Vec<(u32, u32)> = Vec::with_capacity(a.len().min(b.len()));
    let mut stack: Vec<Region> = vec![(0, a.len(), 0, b.len())];

    while let Some((mut a_lo, mut a_hi, mut b_lo, mut b_hi)) = stack.pop() {
        // Peel the common prefix: those lines are unconditionally matched.
        while a_lo < a_hi && b_lo < b_hi && a[a_lo] == b[b_lo] {
            out.push((a_lo as u32, b_lo as u32));
            a_lo += 1;
            b_lo += 1;
        }
        // Peel the common suffix.
        while a_lo < a_hi && b_lo < b_hi && a[a_hi - 1] == b[b_hi - 1] {
            a_hi -= 1;
            b_hi -= 1;
            out.push((a_hi as u32, b_hi as u32));
        }

        // One side exhausted: the remainder is pure insert/delete, no matches.
        if a_lo >= a_hi || b_lo >= b_hi {
            continue;
        }

        match bisect(&a[a_lo..a_hi], &b[b_lo..b_hi], &mut frontiers) {
            Some((x, y)) if !((x == 0 && y == 0) || (x == a_hi - a_lo && y == b_hi - b_lo)) => {
                stack.push((a_lo, a_lo + x, b_lo, b_lo + y));
                stack.push((a_lo + x, a_hi, b_lo + y, b_hi));
            }
            // Degenerate split: impossible after peeling (documented above), but
            // the region is still handled correctly as a full replacement.
            _ => debug_assert!(false, "bisect must return an interior split"),
        }
    }

    // Regions are visited out of order by the stack; the model layer requires
    // ascending matches.
    out.sort_unstable();
    out
}

/// Find a point on an optimal edit path that splits the region into two parts.
///
/// This is the "middle snake" step of Myers' linear-space refinement: run the
/// forward search and the backward search (over reversed slices) in lock-step
/// until their frontiers overlap. Such an overlap proves the two halves are each
/// optimally solvable, so recursing on both preserves minimality while never
/// allocating the O(D^2) trace.
///
/// `left` and `right` are non-empty and mismatch at both ends.
fn bisect(left: &[u32], right: &[u32], frontiers: &mut Frontiers) -> Option<(usize, usize)> {
    let n = left.len() as isize;
    let m = right.len() as isize;
    let delta = n - m;
    // Only one direction can see the overlap, decided by the parity of delta.
    let check_forward = delta & 1 != 0;
    let max_d = (n + m + 1) / 2;
    let off = frontiers.prepare(max_d);
    let vf = &mut frontiers.vf;
    let vb = &mut frontiers.vb;
    let v_len = vf.len() as isize;

    // Diagonals whose frontier left the box are dead; skip them from both ends.
    let (mut f_lo, mut f_hi, mut b_lo, mut b_hi) = (0isize, 0isize, 0isize, 0isize);

    for d in 0..=max_d {
        // ---- forward pass ---------------------------------------------------
        let mut k = -d + f_lo;
        while k <= d - f_hi {
            let idx = off + k;
            // Arrive from `k+1` (a deletion: x unchanged) or `k-1` (an insertion:
            // x+1). A neighbour still at -1 is unreachable and must not win.
            let mut x = if k == -d || (k != d && vf[(idx - 1) as usize] < vf[(idx + 1) as usize]) {
                vf[(idx + 1) as usize]
            } else {
                vf[(idx - 1) as usize] + 1
            };
            let mut y = x - k;

            while x >= 0 && y >= 0 && x < n && y < m && left[x as usize] == right[y as usize] {
                x += 1;
                y += 1;
            }
            if x < 0 || y < 0 {
                k += 2;
                continue;
            }
            vf[idx as usize] = x;

            if x > n {
                f_hi += 2;
            } else if y > m {
                f_lo += 2;
            } else if check_forward {
                let jdx = off + delta - k;
                if jdx >= 0 && jdx < v_len && vb[jdx as usize] != -1 {
                    // The backward frontier is in reversed coordinates.
                    if x >= n - vb[jdx as usize] {
                        return Some((x as usize, y as usize));
                    }
                }
            }
            k += 2;
        }

        // ---- backward pass ---------------------------------------------------
        let mut k = -d + b_lo;
        while k <= d - b_hi {
            let idx = off + k;
            let mut x = if k == -d || (k != d && vb[(idx - 1) as usize] < vb[(idx + 1) as usize]) {
                vb[(idx + 1) as usize]
            } else {
                vb[(idx - 1) as usize] + 1
            };
            let mut y = x - k;

            // Walk the reversed slices: index 0 is the region's last element.
            while x >= 0
                && y >= 0
                && x < n
                && y < m
                && left[(n - 1 - x) as usize] == right[(m - 1 - y) as usize]
            {
                x += 1;
                y += 1;
            }
            if x < 0 || y < 0 {
                k += 2;
                continue;
            }
            vb[idx as usize] = x;

            if x > n {
                b_hi += 2;
            } else if y > m {
                b_lo += 2;
            } else if !check_forward {
                let jdx = off + delta - k;
                if jdx >= 0 && jdx < v_len && vf[jdx as usize] != -1 {
                    let fx = vf[jdx as usize];
                    if fx + x >= n {
                        // Mirror the forward extent onto its own diagonal.
                        let fy = fx - (delta - k);
                        return Some((fx as usize, fy as usize));
                    }
                }
            }
            k += 2;
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Brute-force LCS length, used as an oracle for the edit distance.
    fn lcs_len(a: &[u32], b: &[u32]) -> usize {
        let (n, m) = (a.len(), b.len());
        let mut prev = vec![0usize; m + 1];
        let mut cur = vec![0usize; m + 1];
        for i in 1..=n {
            for j in 1..=m {
                cur[j] = if a[i - 1] == b[j - 1] {
                    prev[j - 1] + 1
                } else {
                    prev[j].max(cur[j - 1])
                };
            }
            std::mem::swap(&mut prev, &mut cur);
        }
        prev[m]
    }

    fn check(a: &[u32], b: &[u32]) -> Vec<(u32, u32)> {
        let got = matches(a, b);
        // Ascending and genuinely equal.
        for w in got.windows(2) {
            assert!(w[0].0 < w[1].0, "left indices must ascend: {got:?}");
            assert!(w[0].1 < w[1].1, "right indices must ascend: {got:?}");
        }
        for &(i, j) in &got {
            assert_eq!(a[i as usize], b[j as usize], "matched pair must be equal");
        }
        // Optimality: number of matches equals the LCS length.
        assert_eq!(
            got.len(),
            lcs_len(a, b),
            "expected a shortest edit script\n a={a:?}\n b={b:?}\n got={got:?}"
        );
        got
    }

    #[test]
    fn empty_inputs() {
        assert!(matches(&[], &[]).is_empty());
        assert!(matches(&[1], &[]).is_empty());
        assert!(matches(&[], &[1]).is_empty());
    }

    #[test]
    fn identical_sequences_match_everything() {
        let a = [1, 2, 3, 4];
        assert_eq!(check(&a, &a).len(), 4);
    }

    #[test]
    fn complete_replacement_has_no_matches() {
        let got = check(&[1, 2, 3], &[4, 5]);
        assert!(got.is_empty());
    }

    #[test]
    fn plain_insertion() {
        // b = a with one line inserted in the middle.
        let got = check(&[1, 2, 3], &[1, 2, 9, 3]);
        assert_eq!(got, vec![(0, 0), (1, 1), (2, 3)]);
    }

    #[test]
    fn plain_deletion() {
        let got = check(&[1, 2, 9, 3], &[1, 2, 3]);
        assert_eq!(got, vec![(0, 0), (1, 1), (3, 2)]);
    }

    #[test]
    fn interleaved_edits() {
        let a = [1, 2, 3, 4, 5, 6, 7, 8];
        let b = [0, 2, 3, 9, 5, 6, 8, 10];
        let got = check(&a, &b);
        assert_eq!(got.len(), 5, "digits 2,3,5,6,8 survive");
    }

    #[test]
    fn repeated_symbols_do_not_break_ordering() {
        let a = [1, 1, 1, 2, 2, 3];
        let b = [1, 2, 2, 2, 3, 3];
        check(&a, &b);
    }

    #[test]
    fn handles_many_duplicates() {
        let a = vec![7u32; 40];
        let b = vec![7u32; 25];
        let got = check(&a, &b);
        assert_eq!(got.len(), 25);
    }

    #[test]
    fn large_random_inputs_stay_optimal() {
        // Deterministic xorshift so failures reproduce.
        let mut seed = 0x2545_F491_4F6C_DD1Du64;
        let mut next = || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            seed
        };
        for _ in 0..40 {
            let n = (next() % 60) as usize;
            let m = (next() % 60) as usize;
            // Small alphabet to force lots of duplicate/reordering cases.
            let a: Vec<u32> = (0..n).map(|_| (next() % 6) as u32).collect();
            let b: Vec<u32> = (0..m).map(|_| (next() % 6) as u32).collect();
            check(&a, &b);
        }
    }

    #[test]
    fn skips_common_prefix_and_suffix_cheaply() {
        let mut a: Vec<u32> = (0..2000).collect();
        let mut b = a.clone();
        a.insert(1000, 99_999);
        b.insert(1000, 88_888);
        let got = check(&a, &b);
        // Two inserts at the same offset: `1000` lines of a survive, everything
        // else about them is identical, so the LCS length is `a.len() - 1`.
        assert_eq!(got.len(), 2000, "every shared line matches; only the insert differs");
    }
}
