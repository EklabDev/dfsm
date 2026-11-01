from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Dict, Union


@dataclass(frozen=True)
class StateValue:
    """Represents a state value, which can be either a simple Leaf state or a Compound nested hierarchy."""

    value: Union[str, Dict[str, StateValue]]

    @classmethod
    def leaf(cls, name: str) -> StateValue:
        return cls(name)

    @classmethod
    def compound(cls, mapping: Dict[str, StateValue]) -> StateValue:
        return cls(dict(sorted(mapping.items())))

    def is_leaf(self) -> bool:
        return isinstance(self.value, str)

    def is_compound(self) -> bool:
        return isinstance(self.value, dict)

    def matches_string(self, s: str) -> bool:
        return self.is_leaf() and self.value == s

    def to_json(self) -> Any:
        if self.is_leaf():
            return self.value
        return {k: v.to_json() for k, v in sorted(self.value.items())}

    @classmethod
    def from_json(cls, val: Any) -> StateValue:
        if isinstance(val, str):
            return cls.leaf(val)
        if isinstance(val, dict):
            return cls.compound({k: cls.from_json(v) for k, v in val.items()})
        if isinstance(val, StateValue):
            return val
        raise ValueError(f"Cannot convert {val!r} to StateValue")

    def __str__(self) -> str:
        if self.is_leaf():
            return self.value
        return json.dumps(self.to_json(), separators=(",", ":"))

    def __repr__(self) -> str:
        return f"StateValue({self.to_json()!r})"

