from __future__ import annotations

import dataclasses
import hashlib
import json
import math
from collections.abc import Mapping
from enum import Enum
from types import MappingProxyType
from typing import Any


def _checked_float(value: float) -> float:
    if not math.isfinite(value):
        raise TypeError("non-finite floats are not JSON-compatible")
    return value


def _checked_string(value: str) -> str:
    try:
        value.encode("utf-8")
    except UnicodeEncodeError as exc:
        raise TypeError("strings must be valid UTF-8") from exc
    return value


def _checked_int(value: int) -> int:
    try:
        str(value)
    except ValueError as exc:
        raise TypeError("integer is too large for canonical JSON") from exc
    return value


def freeze_json(value: Any) -> Any:
    """Return an immutable, canonically encodable snapshot of JSON-like data."""
    if isinstance(value, Mapping):
        frozen: dict[str, Any] = {}
        for key, item in value.items():
            if type(key) is not str:
                raise TypeError("mapping keys must be strings")
            frozen[_checked_string(key)] = freeze_json(item)
        return MappingProxyType(frozen)
    if isinstance(value, (list, tuple)):
        return tuple(freeze_json(item) for item in value)
    if isinstance(value, Enum):
        return freeze_json(value.value)
    if type(value) is float:
        return _checked_float(value)
    if type(value) is str:
        return _checked_string(value)
    if type(value) is int:
        return _checked_int(value)
    if value is None or type(value) is bool:
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
            if type(key) is not str:
                raise TypeError("mapping keys must be strings")
            out[_checked_string(key)] = _normalise(item)
        return {key: out[key] for key in sorted(out)}
    if isinstance(value, (list, tuple)):
        return [_normalise(v) for v in value]
    if type(value) is float:
        return _checked_float(value)
    if type(value) is str:
        return _checked_string(value)
    if type(value) is int:
        return _checked_int(value)
    if value is None or type(value) is bool:
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


def canonical_digest(value: Any) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()
