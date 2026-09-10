from __future__ import annotations

from dataclasses import asdict
import json
from pathlib import Path

from experiment import Metrics, run


def encode(value):
    if isinstance(value, Metrics):
        return asdict(value)
    if isinstance(value, dict):
        return {key: encode(item) for key, item in value.items()}
    return value


def main() -> None:
    result = encode(run())
    out = Path(__file__).parent / "results" / "summary.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
    print(out)


if __name__ == "__main__":
    main()
