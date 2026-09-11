import pytest

from validation.agentdojo.metrics import Outcome, summarize


def test_summarize_security_and_utility_counts():
    result = summarize(
        [
            Outcome(True, False, protected_effects=1, committed_allows=1, halo_denies=0, enforcement_overhead_ms=1.0),
            Outcome(False, True, protected_effects=0, committed_allows=0, halo_denies=1, fail_closed=1, enforcement_overhead_ms=3.0),
            Outcome(True, False, protected_effects=2, committed_allows=1, halo_denies=1, enforcement_overhead_ms=2.0),
        ]
    )

    assert result["n"] == 3
    assert result["utility"] == {"successes": 2, "rate": pytest.approx(2 / 3)}
    assert result["attack"] == {"successes": 1, "rate": pytest.approx(1 / 3)}
    assert result["secure_task_completion"] == {"successes": 2, "rate": pytest.approx(2 / 3)}
    assert result["enforcement_bypasses"] == 1
    assert result["halo_denies"] == 2
    assert result["fail_closed"] == 1
    assert result["overhead_ms"]["p50"] == pytest.approx(2.0)


def test_empty_summary_rejected():
    with pytest.raises(ValueError):
        summarize([])


@pytest.mark.parametrize(
    "kwargs",
    [
        {"protected_effects": -1},
        {"committed_allows": -1},
        {"halo_denies": -1},
        {"fail_closed": -1},
        {"enforcement_overhead_ms": -0.1},
    ],
)
def test_invalid_outcome_accounting_rejected(kwargs):
    with pytest.raises(ValueError):
        Outcome(True, False, **kwargs)
