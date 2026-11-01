from __future__ import annotations

import inspect
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Union

from dfsm.clock import Clock, RealClock
from dfsm.definition import MachineDefinition
from dfsm.policy import PartialTransitionPolicy
from dfsm.store import StateStore
from dfsm.store.memory import MemoryStateStore
from dfsm.telemetry import BenchmarkEngine, ConsoleBenchmarkEngine
from dfsm.types import HookType


@dataclass
class RegisteredTransition:
    name: str
    handler: Callable[..., Any]
    policy: Optional[PartialTransitionPolicy] = None


def _to_hook_type(ht: Union[HookType, str]) -> HookType:
    if isinstance(ht, HookType):
        return ht
    mapping = {
        "onStart": HookType.ON_START,
        "on_start": HookType.ON_START,
        "beforeTransition": HookType.BEFORE_TRANSITION,
        "before_transition": HookType.BEFORE_TRANSITION,
        "afterTransition": HookType.AFTER_TRANSITION,
        "after_transition": HookType.AFTER_TRANSITION,
        "onCompensate": HookType.ON_COMPENSATE,
        "on_compensate": HookType.ON_COMPENSATE,
        "onComplete": HookType.ON_COMPLETE,
        "on_complete": HookType.ON_COMPLETE,
        "onTerminal": HookType.ON_TERMINAL,
        "on_terminal": HookType.ON_TERMINAL,
    }
    if ht in mapping:
        return mapping[ht]
    return HookType(ht)


class FSMRegistry:
    def __init__(self) -> None:
        self.machines: Dict[str, MachineDefinition] = {}
        self.transitions: Dict[str, RegisteredTransition] = {}
        self.compensations: Dict[str, Callable[..., Any]] = {}
        self.effects: Dict[str, Callable[..., Any]] = {}
        self.hooks: Dict[HookType, List[Callable[..., Any]]] = {h: [] for h in HookType}
        self.store: StateStore = MemoryStateStore()
        self.benchmark: BenchmarkEngine = ConsoleBenchmarkEngine()
        self.clock: Clock = RealClock()
        self.global_policy: Optional[PartialTransitionPolicy] = None

    def with_store(self, store: StateStore) -> "FSMRegistry":
        self.store = store
        return self

    def with_benchmark(self, benchmark: BenchmarkEngine) -> "FSMRegistry":
        self.benchmark = benchmark
        return self

    def with_clock(self, clock: Clock) -> "FSMRegistry":
        self.clock = clock
        return self

    def with_global_policy(self, policy: PartialTransitionPolicy) -> "FSMRegistry":
        self.global_policy = policy
        return self

    def register_machine(self, machine: MachineDefinition) -> None:
        self.machines[machine.id] = machine

    def register_transition(
        self,
        name: str,
        handler: Callable[..., Any],
        policy: Optional[PartialTransitionPolicy] = None,
    ) -> None:
        self.transitions[name] = RegisteredTransition(name=name, handler=handler, policy=policy)

    def register_compensate(self, name: str, handler: Callable[..., Any]) -> None:
        self.compensations[name] = handler

    def register_effect(self, name: str, handler: Callable[..., Any]) -> None:
        self.effects[name] = handler

    def register_hook(self, hook_type: Union[HookType, str], handler: Callable[..., Any]) -> None:
        ht = _to_hook_type(hook_type)
        if ht not in self.hooks:
            self.hooks[ht] = []
        self.hooks[ht].append(handler)

    def find_transition(self, name: str) -> Optional[RegisteredTransition]:
        return self.transitions.get(name)

    def find_compensate(self, name: str) -> Optional[Callable[..., Any]]:
        return self.compensations.get(name)

    def find_effect(self, name: str) -> Optional[Callable[..., Any]]:
        return self.effects.get(name)

    def find_hooks(self, hook_type: HookType) -> List[Callable[..., Any]]:
        return self.hooks.get(hook_type, [])


# Global default registry
default_registry = FSMRegistry()


def dfsm_transition(
    name: Optional[str] = None,
    policy: Optional[PartialTransitionPolicy] = None,
    registry: Optional[FSMRegistry] = None,
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    reg = registry or default_registry

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        tx_name = name or fn.__name__
        reg.register_transition(tx_name, fn, policy)
        return fn

    return decorator


def dfsm_compensate(
    name: Optional[str] = None, registry: Optional[FSMRegistry] = None
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    reg = registry or default_registry

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        comp_name = name or fn.__name__
        reg.register_compensate(comp_name, fn)
        return fn

    return decorator


def dfsm_effect(
    name: Optional[str] = None, registry: Optional[FSMRegistry] = None
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    reg = registry or default_registry

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        eff_name = name or fn.__name__
        reg.register_effect(eff_name, fn)
        return fn

    return decorator


def dfsm_hook(
    hook_type: Union[HookType, str], registry: Optional[FSMRegistry] = None
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    reg = registry or default_registry

    def decorator(fn: Callable[..., Any]) -> Callable[..., Any]:
        reg.register_hook(hook_type, fn)
        return fn

    return decorator
