import pytest

from halo.safety_cases import _scan_for_secrets
from experiments.e003_verdict_freshness.experiment import run


@pytest.mark.parametrize("template", ["{}", "'{}'", '{{"value": "{}"}}', "[{}],"])
def test_base64_candidate_survives_punctuation(template):
    assert "base64_high_entropy" in _scan_for_secrets(template.format("A" * 42 + "=="))


@pytest.mark.parametrize("suffix", ["", " note=x=1", " note=+plus", " /path"])
def test_hash_cannot_borrow_a_base64_marker(suffix):
    assert "base64_high_entropy" not in _scan_for_secrets("a" * 64 + suffix)


@pytest.mark.parametrize("window,expected", [(3, 2), (5, 2), (7, 4)])
def test_freshness_preserves_ties_to_even_reference(window, expected):
    _, diagnostics = run(seed=3, n=10, delay_steps=3,
                         volatility=0.5, freshness_window=window)
    assert diagnostics["adaptive_window_size"] == expected
    assert diagnostics["progressive_revalidation_count"] == 3 // (expected + 1)
