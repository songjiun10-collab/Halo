"""Check local inline Markdown destinations, not remote URLs or heading anchors."""
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit


def test_repository_markdown_local_destinations_exist():
    root = Path(__file__).resolve().parents[1]
    paths = subprocess.check_output(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=root).decode().split("\0")
    broken = []
    for name in sorted(set(paths)):
        if not name.endswith(".md") or not (root / name).is_file():
            continue
        text = (root / name).read_text()
        text = re.sub(r"(?ms)^\s*(`{3,}|~{3,}).*?^\s*\1\s*$", "", text)
        text = re.sub(r"`[^`\n]*`", "", text)
        for match in re.finditer(r"\[[^\]\n]*\]\((<[^>]+>|[^\s)]+)(?:\s+\"[^\"]*\")?\)", text):
            target = match.group(1).strip("<>")
            url = urlsplit(target)
            if url.scheme or url.netloc or not url.path:
                continue
            if not ((root / name).parent / unquote(url.path)).exists():
                broken.append(f"{name}: {target}")
    assert not broken, "Broken local Markdown destinations:\n" + "\n".join(broken)
