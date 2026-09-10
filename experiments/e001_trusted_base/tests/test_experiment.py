from experiments.e001_trusted_base.experiment import Action, Resource, ground_truth_allow, run


def test_ground_truth():
    assert ground_truth_allow(Action(1, "read"), Resource(1, True, False))
    assert not ground_truth_allow(Action(1, "write"), Resource(1, True, True))
    assert ground_truth_allow(Action(1, "write"), Resource(1, False, True))


def test_zero_corruption_deterministic():
    out = run(seed=1, corruption=0, n=5000)["deterministic"]
    assert out["containment_failure_rate"] == 0
    assert out["false_block_rate"] == 0
