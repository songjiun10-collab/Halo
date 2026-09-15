import importlib.util
from pathlib import Path
import sys

import pytest


@pytest.mark.skipif(sys.platform != "darwin", reason="requires Seatbelt")
def test_denied_semaphore_is_not_reported_as_created():
    path = Path(__file__).resolve().parents[1] / "artifacts/sandbox_benchmark/run_round5.py"
    spec = importlib.util.spec_from_file_location("round5_probe", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.CASES = ["sem_open"]
    rows = module.run_round5(1)["trials"]
    permissive, hardened = rows
    assert permissive["outcome"] == "escaped"
    assert hardened["outcome"] == "blocked", hardened["evidence"]
    assert hardened["evidence"]["sem"]["create"]["fd"] is False
    assert "unlink" not in hardened["evidence"]["sem"]


@pytest.mark.skipif(sys.platform != "darwin", reason="requires Seatbelt")
def test_invalid_fsgetpath_fixture_is_never_counted_as_blocked():
    path = Path(__file__).resolve().parents[1] / "artifacts/sandbox_benchmark/run_round5.py"
    spec = importlib.util.spec_from_file_location("round5_fixture_probe", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    module.CASES = ["fsgetpath"]
    report = module.run_round5(1)
    assert all(row["outcome"] == "unsupported" for row in report["trials"])
    assert report["summary"]["HARDENED"]["fsgetpath"]["blocked"] == 0
