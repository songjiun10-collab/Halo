//! Calibrated monitoring with explicit missing-evidence abstention.
//! Calibration rows must be independently verified benign by the caller.
#[derive(Debug, PartialEq)]
pub enum Decision {
    Allow,
    Block,
    Revalidate,
}

pub struct Shield {
    threshold: f64,
    hybrid: bool,
}

fn hybrid_score(row: [f64; 4]) -> f64 {
    let max = row.into_iter().fold(f64::NEG_INFINITY, f64::max);
    score(row) * 0.5 + max * 0.25
}

fn score(row: [f64; 4]) -> f64 {
    let mut sorted = row;
    sorted.sort_by(f64::total_cmp);
    // Median centering removes common additive shifts. Scaling before
    // subtraction bounds intermediate arithmetic for finite extreme inputs.
    sorted[3] * 0.5 - (sorted[1] * 0.25 + sorted[2] * 0.25)
}

impl Shield {
    pub fn calibrate(benign: &[[f64; 4]], budget: f64) -> Result<Self, String> {
        Self::fit(benign, budget, false)
    }

    /// Fixed equal blend of centered and raw maximum scores; calibrate separately.
    pub fn calibrate_hybrid(benign: &[[f64; 4]], budget: f64) -> Result<Self, String> {
        Self::fit(benign, budget, true)
    }

    fn fit(benign: &[[f64; 4]], budget: f64, hybrid: bool) -> Result<Self, String> {
        if benign.is_empty()
            || !budget.is_finite()
            || !(0.0..1.0).contains(&budget)
            || benign.iter().flatten().any(|x| !x.is_finite())
        {
            return Err("finite verified benign calibration and budget in [0,1) required".into());
        }
        let mut scores: Vec<_> = benign
            .iter()
            .map(|r| if hybrid { hybrid_score(*r) } else { score(*r) })
            .collect();
        let allowed = (budget * scores.len() as f64).floor() as usize;
        let index = scores.len() - allowed - 1;
        let (_, threshold, _) = scores.select_nth_unstable_by(index, f64::total_cmp);
        Ok(Self {
            threshold: *threshold,
            hybrid,
        })
    }

    pub fn decide(&self, evidence: [Option<f64>; 4]) -> Decision {
        let mut row = [0.; 4];
        for (i, value) in evidence.iter().enumerate() {
            match value {
                Some(v) if v.is_finite() => row[i] = *v,
                _ => return Decision::Revalidate,
            }
        }
        let value = if self.hybrid {
            hybrid_score(row)
        } else {
            score(row)
        };
        if value > self.threshold {
            Decision::Block
        } else {
            Decision::Allow
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn missing_or_invalid_evidence_never_allows() {
        let s = Shield::calibrate(&[[0.; 4]; 100], 0.01).unwrap();
        assert_eq!(s.decide([Some(0.); 4]), Decision::Allow);
        for i in 0..4 {
            for v in [None, Some(f64::NAN), Some(f64::INFINITY)] {
                let mut row = [Some(0.); 4];
                row[i] = v;
                assert_eq!(s.decide(row), Decision::Revalidate);
            }
        }
    }
    #[test]
    fn common_offset_and_channel_order_do_not_change_score() {
        assert_eq!(score([1., 2., 3., 8.]), score([108., 103., 102., 101.]));
    }
    #[test]
    fn finite_extremes_and_ties_respect_budget() {
        assert!(score([-f64::MAX, -f64::MAX, f64::MAX, f64::MAX]).is_finite());
        let rows = [[0.; 4]; 100];
        let s = Shield::calibrate(&rows, 0.).unwrap();
        assert!(rows
            .iter()
            .all(|r| s.decide(r.map(Some)) == Decision::Allow));
        assert!(Shield::calibrate(&rows, 1.).is_err());
        assert!(Shield::calibrate(&[], 0.1).is_err());
    }

    #[test]
    fn hybrid_preserves_missing_evidence_gate_and_calibration_budget() {
        let rows: Vec<_> = (0..100).map(|i| [i as f64, 0., 0., 0.]).collect();
        let s = Shield::calibrate_hybrid(&rows, 0.1).unwrap();
        assert_eq!(
            rows.iter()
                .filter(|r| s.decide(r.map(Some)) == Decision::Block)
                .count(),
            10
        );
        for i in 0..4 {
            let mut row = [Some(0.); 4];
            row[i] = None;
            assert_eq!(s.decide(row), Decision::Revalidate);
        }
        assert!(hybrid_score([f64::MAX; 4]).is_finite());
        assert!(hybrid_score([-f64::MAX; 4]).is_finite());
    }
}
