from pathlib import Path

import pytest

from artifacts.sandbox_benchmark.run_benchmark import sandbox_profile, validate_workspace


def test_rejects_preexisting_external_hardlink(tmp_path: Path):
    work = tmp_path / "work"
    outside = tmp_path / "outside.txt"
    work.mkdir()
    outside.write_text("synthetic canary")
    (work / "alias").hardlink_to(outside)

    with pytest.raises(ValueError, match="hardlinked"):
        validate_workspace(work)


def test_accepts_workspace_with_normal_files_and_symlinks(tmp_path: Path):
    work = tmp_path / "work"
    target = tmp_path / "target.txt"
    work.mkdir()
    (work / "input.txt").write_text("public input")
    target.write_text("synthetic canary")
    (work / "link").symlink_to(target)

    validate_workspace(work)


def test_profile_allows_only_declared_entrypoint(tmp_path: Path):
    profile = sandbox_profile(tmp_path / "work", Path("/usr/bin/python3"))
    assert "(allow process-exec (literal \"/usr/bin/python3\")" in profile
    assert "process-fork" not in profile
