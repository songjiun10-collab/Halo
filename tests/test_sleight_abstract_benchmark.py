from benchmarks.sleight_abstract.benchmark import CASES, run


def test_all_public_sleight_categories_are_represented():
    assert len(CASES) == 11
    assert len({case.category for case in CASES}) == 11


def test_benign_pairs_currently_have_no_policy_false_positives():
    rows = run()
    assert not any(row["false_positive"] for row in rows)


def test_benchmark_exposes_current_gaps():
    rows = run()
    caught = sum(row["caught"] for row in rows)
    assert caught == 4
