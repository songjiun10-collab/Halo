from __future__ import annotations

import dataclasses
import json
from collections.abc import Mapping
from enum import Enum
from types import MappingProxyType
from typing import Any


def freeze_json(value: Any) -> Any:
    """Return an immutable snapshot of JSON-like data.

    Mapping keys must already be strings. Lists/tuples become tuples and
    mappings become read-only proxies. Unsupported values are rejected so a
    security decision is never made over data that cannot be authenticated
    canonically.
    """
    if isinstance(value, Mapping):
        frozen: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("mapping keys must be strings")
            frozen[key] = freeze_json(item)
        return MappingProxyType(frozen)
    if isinstance(value, (list, tuple)):
        return tuple(freeze_json(item) for item in value)
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"value of type {type(value).__name__} is not JSON-compatible")


def _normalise(value: Any) -> Any:
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return {
            field.name: _normalise(getattr(value, field.name))
            for field in dataclasses.fields(value)
        }
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise TypeError("mapping keys must be strings")
            out[key] = _normalise(item)
        return {key: out[key] for key in sorted(out)}
    if isinstance(value, (list, tuple)):
        return [_normalise(v) for v in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise TypeError(f"value of type {type(value).__name__} is not canonically serialisable")


def canonical_json(value: Any) -> bytes:
    return json.dumps(
        _normalise(value),
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")
