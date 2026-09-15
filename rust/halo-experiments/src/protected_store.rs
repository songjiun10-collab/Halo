//! Reference enforcement boundary for application-owned in-memory objects.
//! The authenticated principal must come from the host, not untrusted payloads.
use crate::shield::{Decision, Shield};
use std::collections::{BTreeMap, BTreeSet};

pub struct ProtectedStore {
    objects: BTreeMap<String, Vec<u8>>,
    readers: BTreeMap<String, BTreeSet<String>>,
    available: bool,
}

#[derive(Debug, PartialEq)]
pub enum AccessError {
    Denied,
    VerificationUnavailable,
    MonitorBlocked,
    EvidenceRequiresRevalidation,
}

pub struct ReadResult {
    pub data: Vec<u8>,
    pub monitor: Decision,
    pub policy_checks: usize,
}

impl Default for ProtectedStore {
    fn default() -> Self {
        Self {
            objects: BTreeMap::new(),
            readers: BTreeMap::new(),
            available: true,
        }
    }
}

impl ProtectedStore {
    /// Trusted administrative API. Replacing an object also replaces its ACL.
    pub fn put(&mut self, key: String, data: Vec<u8>, readers: BTreeSet<String>) {
        self.readers.insert(key.clone(), readers);
        self.objects.insert(key, data);
    }

    /// Host health input, never controlled by the request being evaluated.
    pub fn set_verifier_available(&mut self, available: bool) {
        self.available = available;
    }

    /// Authorization and the actual read share one immutable borrow. Every
    /// request is checked, including low-risk monitor decisions. No reusable
    /// boolean permission token can be replayed against another object.
    pub fn read(
        &self,
        shield: &Shield,
        principal: &str,
        key: &str,
        evidence: [Option<f64>; 4],
    ) -> Result<ReadResult, AccessError> {
        if !self.available {
            return Err(AccessError::VerificationUnavailable);
        }
        if !self.readers.get(key).is_some_and(|r| r.contains(principal)) {
            return Err(AccessError::Denied);
        }
        let monitor = shield.decide(evidence);
        match monitor {
            Decision::Block => return Err(AccessError::MonitorBlocked),
            Decision::Revalidate => return Err(AccessError::EvidenceRequiresRevalidation),
            Decision::Allow => {}
        }
        let data = self.objects.get(key).ok_or(AccessError::Denied)?.clone();
        Ok(ReadResult {
            data,
            monitor,
            policy_checks: 1,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn authorized_requests_cannot_bypass_monitor_denial_or_missing_evidence() {
        let shield = Shield::calibrate(&[[0.; 4]; 100], 0.01).unwrap();
        let mut store = ProtectedStore::default();
        store.put(
            "doc".into(),
            b"secret".to_vec(),
            BTreeSet::from(["alice".into()]),
        );
        assert!(matches!(
            store.read(
                &shield,
                "alice",
                "doc",
                [Some(100.), Some(0.), Some(0.), Some(0.)]
            ),
            Err(AccessError::MonitorBlocked)
        ));
        for channel in 0..4 {
            for invalid in [
                None,
                Some(f64::NAN),
                Some(f64::INFINITY),
                Some(f64::NEG_INFINITY),
            ] {
                let mut evidence = [Some(0.); 4];
                evidence[channel] = invalid;
                assert!(matches!(
                    store.read(&shield, "alice", "doc", evidence),
                    Err(AccessError::EvidenceRequiresRevalidation)
                ));
            }
        }
        assert_eq!(
            store
                .read(&shield, "alice", "doc", [Some(0.); 4])
                .unwrap()
                .data,
            b"secret"
        );
    }
    #[test]
    fn execution_remains_correct_under_noise_and_total_sensor_loss() {
        let shield = Shield::calibrate(&[[0.; 4]; 100], 0.01).unwrap();
        let mut store = ProtectedStore::default();
        store.put(
            "document".into(),
            b"public".to_vec(),
            BTreeSet::from(["alice".into()]),
        );
        store.put(
            "private".into(),
            b"secret".to_vec(),
            BTreeSet::from(["admin".into()]),
        );
        for i in 0..1000 {
            let noise = i as f64 * 100.;
            for evidence in [
                [None; 4],
                [Some(0.); 4],
                [Some(noise); 4],
                [Some(noise), Some(0.), Some(0.), Some(0.)],
                [Some(noise), Some(-noise), Some(noise), Some(f64::NAN)],
            ] {
                let result = store.read(&shield, "alice", "document", evidence);
                match shield.decide(evidence) {
                    Decision::Allow => {
                        let allowed = result.unwrap();
                        assert_eq!(allowed.data, b"public");
                        assert_eq!(allowed.policy_checks, 1);
                    }
                    Decision::Block => assert!(matches!(result, Err(AccessError::MonitorBlocked))),
                    Decision::Revalidate => assert!(matches!(
                        result,
                        Err(AccessError::EvidenceRequiresRevalidation)
                    )),
                }
                assert!(matches!(
                    store.read(&shield, "alice", "private", evidence),
                    Err(AccessError::Denied)
                ));
            }
        }
    }
    #[test]
    fn failure_and_permission_revocation_do_not_allow_reads() {
        let shield = Shield::calibrate(&[[0.; 4]; 100], 0.01).unwrap();
        let mut store = ProtectedStore::default();
        store.put("doc".into(), vec![1], BTreeSet::from(["alice".into()]));
        assert!(store.read(&shield, "alice", "doc", [Some(0.); 4]).is_ok());
        store.put("doc".into(), vec![2], BTreeSet::new());
        assert!(matches!(
            store.read(&shield, "alice", "doc", [Some(0.); 4]),
            Err(AccessError::Denied)
        ));
        store.set_verifier_available(false);
        assert!(matches!(
            store.read(&shield, "alice", "doc", [None; 4]),
            Err(AccessError::VerificationUnavailable)
        ));
    }
}
