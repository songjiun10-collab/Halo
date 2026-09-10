from benchmarks.sleight_abstract.benchmark import CASES, run


EXPECTED_CATEGORIES = {
    "file_object_reuse",
    "counting",
    "system_state",
    "model_priors",
    "authorization_confusion",
    "needle_in_haystack",
    "n_hops",
    "plausible_naming",
    "omission",
    "multi_session",
    "jailbreaks",
}


def test_all_public_sleight_categories_are_represented():
    assert {case.category for case in CASES} == EXPECTED_CATEGORIES


def test_benign_pairs_currently_have_no_policy_false_positives():
    rows = run()
    assert not any(row["false_positive"] for row in rows)


def test_benchmark_exposes_current_gaps():
    rows = run()
    caught = sum(row["caught"] for row in rows)
    assert caught == 4
