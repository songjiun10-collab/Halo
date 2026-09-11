from halo.safety_cases import Event, Signal
from halo.trace_context import ContextMonitor, TraceContract


def _write(metadata):
    return Event(
        kind="tool",
        action="send_message",
        effect="external_write",
        target_scope="external",
        declared_scope="external",
        contains_secret=False,
        telemetry_complete=True,
        approved=True,
        metadata=metadata,
    )


def test_transitive_untrusted_dependency_reaches_effect():
    monitor = ContextMonitor()
    findings = monitor.evaluate_session([
        Event(kind="observation", provenance="untrusted", metadata={"event_id": "src"}),
        Event(
            kind="tool",
            action="read",
            effect="read_only",
            metadata={"event_id": "read", "depends_on": ["src"]},
        ),
        Event(
            kind="tool",
            action="compute",
            effect="local_compute",
            metadata={"event_id": "derived", "depends_on": ["read"]},
        ),
        _write({"event_id": "effect", "depends_on": ["derived"]}),
    ])
    risky = [f for f in findings if f.signal is Signal.UNTRUSTED_INSTRUCTION]
    assert len(risky) == 1
    assert risky[0].effectful is True
    assert risky[0].severity == 5


def test_trusted_dependency_chain_is_not_flagged():
    monitor = ContextMonitor()
    findings = monitor.evaluate_session([
        Event(kind="observation", provenance="trusted", metadata={"event_id": "src"}),
        Event(
            kind="tool",
            action="compute",
            effect="local_compute",
            metadata={"event_id": "derived", "depends_on": ["src"]},
        ),
        _write({"event_id": "effect", "depends_on": ["derived"]}),
    ])
    assert findings == []


def test_required_evidence_omission_is_monitoring_gap():
    monitor = ContextMonitor()
    findings = monitor.evaluate_session(
        [Event(kind="observation", metadata={"evidence_tags": ["started"]})],
        TraceContract(required_evidence=frozenset({"completed"})),
    )
    gaps = [f for f in findings if f.signal is Signal.MONITORING_GAP]
    assert len(gaps) == 1
    assert gaps[0].effectful is False


def test_dependency_state_persists_across_sessions():
    monitor = ContextMonitor()
    first = monitor.evaluate_session([
        Event(kind="observation", provenance="untrusted", metadata={"event_id": "prior"})
    ])
    second = monitor.evaluate_session([
        _write({"event_id": "later", "depends_on": ["prior"]})
    ])
    assert first == []
    assert any(
        f.signal is Signal.UNTRUSTED_INSTRUCTION and f.effectful
        for f in second
    )


def test_unknown_dependency_fails_closed_as_missing_context():
    monitor = ContextMonitor()
    findings = monitor.evaluate_session([
        _write({"event_id": "effect", "depends_on": ["missing"]})
    ])
    gaps = [f for f in findings if f.signal is Signal.MONITORING_GAP]
    assert len(gaps) == 1
    assert gaps[0].effectful is True


def test_duplicate_event_id_is_ambiguous_context():
    monitor = ContextMonitor()
    monitor.evaluate_session([
        Event(kind="observation", metadata={"event_id": "same"})
    ])
    findings = monitor.evaluate_session([
        Event(kind="observation", metadata={"event_id": "same"})
    ])
    assert any(f.signal is Signal.MONITORING_GAP for f in findings)


def test_exact_count_mismatch_is_state_mismatch():
    findings = ContextMonitor().evaluate_session(
        [Event(kind="observation", metadata={"observed_counts": {"records": 41}})],
        TraceContract(expected_counts=(("records", 40),)),
    )
    assert any(f.signal is Signal.STATE_MISMATCH for f in findings)


def test_exact_count_match_is_clean():
    findings = ContextMonitor().evaluate_session(
        [Event(kind="observation", metadata={"observed_counts": {"records": 40}})],
        TraceContract(expected_counts=(("records", 40),)),
    )
    assert findings == []


def test_missing_or_malformed_count_fails_closed():
    contract = TraceContract(expected_counts=(("records", 40),))
    missing = ContextMonitor().evaluate_session(
        [Event(kind="observation", metadata={})], contract
    )
    malformed = ContextMonitor().evaluate_session(
        [Event(kind="observation", metadata={"observed_counts": {"records": True}})],
        contract,
    )
    assert any(f.signal is Signal.MONITORING_GAP for f in missing)
    assert any(f.signal is Signal.MONITORING_GAP for f in malformed)


def test_conflicting_trusted_counts_are_ambiguous():
    findings = ContextMonitor().evaluate_session(
        [
            Event(kind="observation", metadata={"observed_counts": {"records": 40}}),
            Event(kind="observation", metadata={"observed_counts": {"records": 41}}),
        ],
        TraceContract(expected_counts=(("records", 40),)),
    )
    assert any(f.signal is Signal.MONITORING_GAP for f in findings)


def test_environment_binding_must_match_trusted_profile():
    findings = ContextMonitor().evaluate_session(
        [Event(kind="tool", action="compute", effect="local_compute", metadata={
            "environment_binding": "profile-standard",
        })],
        TraceContract(environment_fingerprint="profile-nonstandard"),
    )
    assert any(f.signal is Signal.STATE_MISMATCH for f in findings)


def test_environment_binding_match_is_clean():
    findings = ContextMonitor().evaluate_session(
        [Event(kind="tool", action="compute", effect="local_compute", metadata={
            "environment_binding": "profile-v2",
        })],
        TraceContract(environment_fingerprint="profile-v2"),
    )
    assert findings == []


def test_missing_environment_binding_is_monitoring_gap():
    findings = ContextMonitor().evaluate_session(
        [Event(kind="tool", action="compute", effect="local_compute", metadata={})],
        TraceContract(environment_fingerprint="profile-v2"),
    )
    assert any(f.signal is Signal.MONITORING_GAP for f in findings)
