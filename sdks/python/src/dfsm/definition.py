from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

import re
import jsonschema
import yaml

from dfsm.errors import DfsmError, SchemaValidationFailedError
from dfsm.policy import PartialTransitionPolicy


class DfsmYamlLoader(yaml.SafeLoader):
    """YAML loader adhering to YAML 1.2 boolean specification (no on/off/yes/no bool parsing)."""
    pass


# Replace bool regex to only recognize true/false, preventing 'on' / 'off' / 'yes' / 'no' collision
_BOOL_RE = re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$")
DfsmYamlLoader.yaml_implicit_resolvers = {
    k: [
        (tag, _BOOL_RE if tag == "tag:yaml.org,2002:bool" else reg)
        for (tag, reg) in resolver_list
        if not (tag == "tag:yaml.org,2002:bool" and k in list("yYnNoOfF"))
    ]
    for k, resolver_list in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
DfsmYamlLoader.yaml_implicit_resolvers["t"] = [("tag:yaml.org,2002:bool", _BOOL_RE)]
DfsmYamlLoader.yaml_implicit_resolvers["T"] = [("tag:yaml.org,2002:bool", _BOOL_RE)]
DfsmYamlLoader.yaml_implicit_resolvers["f"] = [("tag:yaml.org,2002:bool", _BOOL_RE)]
DfsmYamlLoader.yaml_implicit_resolvers["F"] = [("tag:yaml.org,2002:bool", _BOOL_RE)]


def _load_schema() -> Dict[str, Any]:
    schema_path = Path(__file__).parent / "schemas" / "dfsm-v1.schema.json"
    if not schema_path.exists():
        # Fallback to repo schema
        schema_path = Path(__file__).resolve().parents[4] / "spec" / "dfsm-v1.schema.json"
    with open(schema_path, "r", encoding="utf-8") as f:
        return json.load(f)


_SCHEMA = _load_schema()
_VALIDATOR = jsonschema.Draft202012Validator(_SCHEMA)


def qualify(name: str, ns: Optional[str]) -> str:
    if not ns or not name or "." in name:
        return name
    return f"{ns}.{name}"


@dataclass
class TransitionDetails:
    target: Optional[str] = None
    transition: Optional[str] = None
    compensate: Optional[str] = None
    retry: Optional[Any] = None
    circuit_breaker: Optional[Any] = None
    on_fail: Optional[Any] = None
    effects: List[str] = field(default_factory=list)

    def to_partial_policy(self) -> Optional[PartialTransitionPolicy]:
        d: Dict[str, Any] = {}
        if self.retry is not None:
            d["retry"] = self.retry
        if self.circuit_breaker is not None:
            d["circuitBreaker"] = self.circuit_breaker
        if self.on_fail is not None:
            d["onFail"] = self.on_fail
        if self.compensate is not None:
            d["compensateWith"] = self.compensate

        if not d:
            return None
        return PartialTransitionPolicy.from_dict(d)


@dataclass
class StateDefinition:
    id: str
    state_type: Optional[str] = None
    initial: Optional[str] = None
    description: Optional[str] = None
    states: Dict[str, StateDefinition] = field(default_factory=dict)
    on: Dict[str, List[TransitionDetails]] = field(default_factory=dict)
    on_done: List[TransitionDetails] = field(default_factory=list)
    entry: List[str] = field(default_factory=list)
    exit: List[str] = field(default_factory=list)

    def is_compound(self) -> bool:
        return bool(self.states) and self.state_type != "parallel"

    def is_parallel(self) -> bool:
        return self.state_type == "parallel"

    def is_final(self) -> bool:
        return self.state_type == "final"


@dataclass
class RegistryConfig:
    namespace: Optional[str] = None
    strict: bool = False


@dataclass
class MachineDefinition:
    id: str
    dfsm: str
    initial: str
    description: Optional[str] = None
    machine_type: Optional[str] = None
    max_effect_chain_depth: int = 25
    states: Dict[str, StateDefinition] = field(default_factory=dict)
    defaults: Optional[PartialTransitionPolicy] = None
    registry: Optional[RegistryConfig] = None
    hooks: Optional[Any] = None
    effects: List[str] = field(default_factory=list)


def _parse_transition_details(val: Any, ns: Optional[str]) -> List[TransitionDetails]:
    res: List[TransitionDetails] = []
    if isinstance(val, str):
        res.append(TransitionDetails(target=val))
    elif isinstance(val, dict):
        tr = qualify(val.get("transition") or val.get("handler", ""), ns) if ("transition" in val or "handler" in val) else None
        comp = qualify(val.get("compensate", ""), ns) if "compensate" in val else None
        effs = [qualify(e, ns) for e in val.get("effects", [])]
        res.append(
            TransitionDetails(
                target=val.get("target"),
                transition=tr,
                compensate=comp,
                retry=val.get("retry"),
                circuit_breaker=val.get("circuitBreaker"),
                on_fail=val.get("onFail"),
                effects=effs,
            )
        )
    elif isinstance(val, list):
        for item in val:
            res.extend(_parse_transition_details(item, ns))
    return res


def _parse_state_def(name: str, data: Dict[str, Any], ns: Optional[str]) -> StateDefinition:
    entry = [qualify(e, ns) for e in (data["entry"] if isinstance(data.get("entry"), list) else [data["entry"]] if data.get("entry") else [])]
    exit_hooks = [qualify(e, ns) for e in (data["exit"] if isinstance(data.get("exit"), list) else [data["exit"]] if data.get("exit") else [])]

    s = StateDefinition(
        id=name,
        state_type=data.get("type"),
        initial=data.get("initial"),
        description=data.get("description"),
        entry=entry,
        exit=exit_hooks,
    )

    if "states" in data and isinstance(data["states"], dict):
        for cname, cdata in data["states"].items():
            if isinstance(cdata, dict):
                s.states[cname] = _parse_state_def(cname, cdata, ns)

    if "on" in data and isinstance(data["on"], dict):
        for evt, tval in data["on"].items():
            s.on[evt] = _parse_transition_details(tval, ns)

    if "onDone" in data:
        s.on_done = _parse_transition_details(data["onDone"], ns)

    return s


def _normalize_yaml_data(val: Any) -> Any:
    if isinstance(val, dict):
        res: Dict[str, Any] = {}
        for k, v in val.items():
            if k is True:
                key_str = "on"
            elif k is False:
                key_str = "off"
            else:
                key_str = str(k)
            res[key_str] = _normalize_yaml_data(v)
        return res
    if isinstance(val, list):
        return [_normalize_yaml_data(x) for x in val]
    return val


def parse_yaml_machine(yaml_str: str) -> MachineDefinition:
    try:
        raw_val = yaml.load(yaml_str, Loader=DfsmYamlLoader)
    except Exception as e:
        raise DfsmError(f"YAML parse error: {e}") from e

    raw_val = _normalize_yaml_data(raw_val)

    if not isinstance(raw_val, dict):
        raise DfsmError("DFSM YAML root must be a mapping")

    errors = sorted(_VALIDATOR.iter_errors(raw_val), key=lambda e: e.path)
    if errors:
        err_msgs = [f"'{'/'.join(str(p) for p in err.path)}': {err.message}" for err in errors]
        raise SchemaValidationFailedError(
            f"DFSM YAML failed JSON Schema validation: {'; '.join(err_msgs)}"
        )

    ns: Optional[str] = None
    reg_cfg: Optional[RegistryConfig] = None
    if "registry" in raw_val and isinstance(raw_val["registry"], dict):
        reg = raw_val["registry"]
        ns = reg.get("namespace")
        reg_cfg = RegistryConfig(namespace=ns, strict=bool(reg.get("strict", False)))

    defaults = PartialTransitionPolicy.from_dict(raw_val.get("defaults")) if "defaults" in raw_val else None

    effects: List[str] = []
    if "effects" in raw_val and isinstance(raw_val["effects"], list):
        effects = [qualify(e, ns) for e in raw_val["effects"] if isinstance(e, str)]

    states: Dict[str, StateDefinition] = {}
    if "states" in raw_val and isinstance(raw_val["states"], dict):
        for sname, sdata in raw_val["states"].items():
            if isinstance(sdata, dict):
                states[sname] = _parse_state_def(sname, sdata, ns)

    # Implicit default 'error' state if not defined
    if "error" not in states:
        states["error"] = StateDefinition(id="error", state_type="final")

    depth = raw_val.get("maxEffectChainDepth", 25)
    if depth <= 0:
        depth = 25

    return MachineDefinition(
        id=str(raw_val.get("id")),
        dfsm=str(raw_val.get("dfsm", "1.0")),
        initial=str(raw_val.get("initial")),
        description=raw_val.get("description"),
        machine_type=raw_val.get("type"),
        max_effect_chain_depth=depth,
        states=states,
        defaults=defaults,
        registry=reg_cfg,
        hooks=raw_val.get("hooks"),
        effects=effects,
    )
