from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from dfsm.definition import MachineDefinition, StateDefinition, TransitionDetails
from dfsm.policy import PartialTransitionPolicy
from dfsm.state_value import StateValue


@dataclass
class InitialStateResult:
    state_value: StateValue
    entry_effects: List[str] = field(default_factory=list)


@dataclass
class MatchedTransition:
    source_path: List[str]
    edge: TransitionDetails
    policy: Optional[PartialTransitionPolicy] = None


@dataclass
class AppliedTransition:
    next_state_value: StateValue
    exit_effects: List[str] = field(default_factory=list)
    entry_effects: List[str] = field(default_factory=list)


class StatechartEngine:
    @classmethod
    def resolve_initial_state(cls, machine: MachineDefinition) -> InitialStateResult:
        entry_effects: List[str] = []
        sv = cls.resolve_initial_node(machine.states, machine.initial, entry_effects)
        return InitialStateResult(state_value=sv, entry_effects=entry_effects)

    @classmethod
    def resolve_initial_node(
        cls,
        states: Dict[str, StateDefinition],
        node_id: str,
        effects: List[str],
    ) -> StateValue:
        node = states.get(node_id)
        if not node:
            return StateValue.leaf(node_id)

        effects.extend(node.entry)

        if node.is_parallel():
            regions: Dict[str, StateValue] = {}
            for rname, rdef in sorted(node.states.items()):
                if rdef.initial:
                    child_val = cls.resolve_initial_node(rdef.states, rdef.initial, effects)
                    regions[rname] = child_val
            return StateValue.compound({node_id: StateValue.compound(regions)})
        elif node.is_compound():
            if node.initial:
                child_val = cls.resolve_initial_node(node.states, node.initial, effects)
                return StateValue.compound({node_id: child_val})
            return StateValue.leaf(node_id)
        else:
            return StateValue.leaf(node_id)

    @classmethod
    def find_transitions(
        cls, machine: MachineDefinition, current_state: StateValue, event: str
    ) -> List[MatchedTransition]:
        results: List[MatchedTransition] = []
        cls._find_in_states(machine.states, current_state, event, [], results)
        return results

    @classmethod
    def _find_in_states(
        cls,
        states: Dict[str, StateDefinition],
        current: StateValue,
        event: str,
        current_path: List[str],
        results: List[MatchedTransition],
    ) -> None:
        if current.is_leaf():
            name = str(current.value)
            path = current_path + [name]
            node = states.get(name)
            if node and event in node.on:
                for detail in node.on[event]:
                    results.append(
                        MatchedTransition(
                            source_path=path,
                            edge=detail,
                            policy=detail.to_partial_policy(),
                        )
                    )
        elif current.is_compound():
            mapping: Dict[str, StateValue] = current.value  # type: ignore
            for parent_name, child_val in mapping.items():
                next_path = current_path + [parent_name]
                parent_def = states.get(parent_name)
                if not parent_def:
                    continue

                cls._find_in_states(parent_def.states, child_val, event, next_path, results)

                if not results and event in parent_def.on:
                    for detail in parent_def.on[event]:
                        results.append(
                            MatchedTransition(
                                source_path=next_path,
                                edge=detail,
                                policy=detail.to_partial_policy(),
                            )
                        )

    @classmethod
    def resolve_target_path(
        cls, machine: MachineDefinition, source_path: List[str], target_ref: str
    ) -> List[str]:
        clean_ref = target_ref.lstrip("#")
        if clean_ref in machine.states:
            return [clean_ref]

        for i in range(len(source_path) - 1, -1, -1):
            candidate = source_path[:i] + [clean_ref]
            if cls.get_node_by_path(machine, candidate) is not None:
                return candidate

        found = cls._find_path_recursive(machine.states, clean_ref, [])
        if found is not None:
            return found

        return [clean_ref]

    @classmethod
    def get_node_by_path(
        cls, machine: MachineDefinition, path: List[str]
    ) -> Optional[StateDefinition]:
        if not path:
            return None
        cur = machine.states.get(path[0])
        if not cur:
            return None
        for seg in path[1:]:
            cur = cur.states.get(seg)
            if not cur:
                return None
        return cur

    @classmethod
    def _find_path_recursive(
        cls, states: Dict[str, StateDefinition], target: str, prefix: List[str]
    ) -> Optional[List[str]]:
        for k, v in states.items():
            cur = prefix + [k]
            if k == target:
                return cur
            found = cls._find_path_recursive(v.states, target, cur)
            if found is not None:
                return found
        return None

    @classmethod
    def apply_target_transition(
        cls,
        machine: MachineDefinition,
        current_state: StateValue,
        source_path: List[str],
        target_name: str,
    ) -> AppliedTransition:
        target_path = cls.resolve_target_path(machine, source_path, target_name)
        exit_effects: List[str] = []
        entry_effects: List[str] = []

        common_len = 0
        max_common = max(0, min(len(source_path), len(target_path)) - 1)
        while common_len < max_common and source_path[common_len] == target_path[common_len]:
            common_len += 1

        target_leaf = target_path[-1]
        target_node = cls.get_node_by_path(machine, target_path)

        if target_node:
            entry_effects.extend(target_node.entry)
            if target_node.is_parallel():
                regions: Dict[str, StateValue] = {}
                for rname, rdef in sorted(target_node.states.items()):
                    if rdef.initial:
                        child_val = cls.resolve_initial_node(rdef.states, rdef.initial, entry_effects)
                        regions[rname] = child_val
                target_subval = StateValue.compound(regions)
            elif target_node.is_compound():
                if target_node.initial:
                    target_subval = cls.resolve_initial_node(target_node.states, target_node.initial, entry_effects)
                else:
                    target_subval = StateValue.leaf(target_leaf)
            else:
                target_subval = StateValue.leaf(target_leaf)
        else:
            target_subval = StateValue.leaf(target_leaf)

        if target_subval.is_leaf() and target_subval.matches_string(target_leaf):
            built_branch = StateValue.leaf(target_leaf)
        else:
            built_branch = StateValue.compound({target_leaf: target_subval})

        # Wrap ancestors down to common_len
        for i in range(len(target_path) - 2, common_len - 1, -1):
            anc_key = target_path[i]
            anc_path = target_path[: i + 1]
            anc_node = cls.get_node_by_path(machine, anc_path)

            if anc_node and anc_node.is_parallel():
                existing_regions = cls._extract_regions(current_state, anc_path)
                region_key = target_path[i + 1]
                if built_branch.is_compound():
                    mapping = dict(built_branch.value)  # type: ignore
                    region_val = mapping.pop(region_key, built_branch)
                else:
                    region_val = built_branch
                existing_regions[region_key] = region_val
                built_branch = StateValue.compound({anc_key: StateValue.compound(existing_regions)})
                continue

            built_branch = StateValue.compound({anc_key: built_branch})

        if common_len == 0:
            next_state = built_branch
        else:
            next_state = cls._replace_at_lca(current_state, target_path[:common_len], built_branch)

        return AppliedTransition(
            next_state_value=next_state,
            exit_effects=exit_effects,
            entry_effects=entry_effects,
        )

    @classmethod
    def _extract_regions(cls, current: StateValue, path: List[str]) -> Dict[str, StateValue]:
        cur = current
        for seg in path:
            if cur.is_compound():
                mapping: Dict[str, StateValue] = cur.value  # type: ignore
                if seg in mapping:
                    cur = mapping[seg]
                else:
                    return {}
            else:
                return {}
        if cur.is_compound():
            return dict(cur.value)  # type: ignore
        return {}

    @classmethod
    def _replace_at_lca(cls, current: StateValue, lca_path: List[str], replacement: StateValue) -> StateValue:
        if not lca_path:
            return replacement
        top = lca_path[0]
        if current.is_compound():
            mapping = dict(current.value)  # type: ignore
            child = mapping.get(top, StateValue.leaf(top))
            mapping[top] = cls._replace_at_lca(child, lca_path[1:], replacement)
            return StateValue.compound(mapping)
        return StateValue.compound({top: replacement})

    @classmethod
    def compute_on_done(
        cls, machine: MachineDefinition, current: StateValue
    ) -> Optional[Tuple[StateValue, List[TransitionDetails]]]:
        if not current.is_compound():
            return None

        mapping: Dict[str, StateValue] = current.value  # type: ignore
        for parent_name, child_val in mapping.items():
            pdef = machine.states.get(parent_name)
            if not pdef:
                continue

            if pdef.is_parallel():
                if not child_val.is_compound():
                    continue
                reg_map: Dict[str, StateValue] = child_val.value  # type: ignore
                all_final = True
                for rname, rsv in reg_map.items():
                    rdef = pdef.states.get(rname)
                    if not rdef or not cls._is_region_final(rdef, rsv):
                        all_final = False
                        break

                if all_final and pdef.on_done:
                    first_edge = pdef.on_done[0]
                    tgt = first_edge.target or parent_name
                    applied = cls.apply_target_transition(machine, current, [parent_name], tgt)
                    return (applied.next_state_value, pdef.on_done)

            elif pdef.is_compound():
                if cls._is_state_val_final(pdef, child_val) and pdef.on_done:
                    first_edge = pdef.on_done[0]
                    tgt = first_edge.target or parent_name
                    applied = cls.apply_target_transition(machine, current, [parent_name], tgt)
                    return (applied.next_state_value, pdef.on_done)

        return None

    @classmethod
    def _is_region_final(cls, rdef: StateDefinition, sv: StateValue) -> bool:
        if sv.is_leaf():
            s = rdef.states.get(str(sv.value))
            return bool(s and s.is_final())
        if sv.is_compound():
            mapping: Dict[str, StateValue] = sv.value  # type: ignore
            for k in mapping:
                s = rdef.states.get(k)
                if s and s.is_final():
                    return True
        return False

    @classmethod
    def _is_state_val_final(cls, pdef: StateDefinition, sv: StateValue) -> bool:
        if sv.is_leaf():
            s = pdef.states.get(str(sv.value))
            return bool(s and s.is_final())
        return False

    @classmethod
    def get_available_events(cls, machine: MachineDefinition, current: StateValue) -> List[str]:
        events: set[str] = set()
        cls._collect_events(machine.states, current, events)
        return sorted(events)

    @classmethod
    def _collect_events(
        cls, states: Dict[str, StateDefinition], current: StateValue, events: set[str]
    ) -> None:
        if current.is_leaf():
            node = states.get(str(current.value))
            if node:
                events.update(node.on.keys())
        elif current.is_compound():
            mapping: Dict[str, StateValue] = current.value  # type: ignore
            for pname, cval in mapping.items():
                pnode = states.get(pname)
                if pnode:
                    events.update(pnode.on.keys())
                    cls._collect_events(pnode.states, cval, events)

    @classmethod
    def get_terminal_states(cls, machine: MachineDefinition) -> List[str]:
        terminals: List[str] = []
        for name, node in machine.states.items():
            if node.is_final():
                terminals.append(name)
        return sorted(terminals)
