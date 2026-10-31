use crate::definition::{MachineDefinition, OnDoneValue, StateDefinition, TransitionDetails, TransitionValue};
use crate::policy::PartialTransitionPolicy;
use crate::state_value::StateValue;
use std::collections::BTreeMap;

#[derive(Debug, Clone)]
pub struct InitialStateResult {
    pub state_value: StateValue,
    pub entry_effects: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct MatchedTransition {
    pub source_path: Vec<String>,
    pub edge: TransitionDetails,
    pub policy: Option<PartialTransitionPolicy>,
}

#[derive(Debug, Clone)]
pub struct AppliedTransition {
    pub next_state_value: StateValue,
    pub exit_effects: Vec<String>,
    pub entry_effects: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PendingOnDone {
    pub source_path: Vec<String>,
    pub edge: TransitionDetails,
}

pub struct StatechartEngine;

impl StatechartEngine {
    pub fn resolve_initial_state(machine: &MachineDefinition) -> InitialStateResult {
        let mut entry_effects = Vec::new();
        let state_val = Self::resolve_initial_node(&machine.states, &machine.initial, &mut entry_effects);
        InitialStateResult {
            state_value: state_val,
            entry_effects,
        }
    }

    fn resolve_initial_node(
        states: &BTreeMap<String, StateDefinition>,
        node_id: &str,
        effects: &mut Vec<String>,
    ) -> StateValue {
        let node = match states.get(node_id) {
            Some(n) => n,
            None => return StateValue::leaf(node_id),
        };

        effects.extend(node.entry.clone());

        if node.is_parallel() {
            let mut regions = BTreeMap::new();
            for (region_id, region_def) in &node.states {
                if let Some(init) = &region_def.initial {
                    let child_val = Self::resolve_initial_node(&region_def.states, init, effects);
                    regions.insert(region_id.clone(), child_val);
                }
            }
            let mut wrapper = BTreeMap::new();
            wrapper.insert(node_id.to_string(), StateValue::Compound(regions));
            StateValue::Compound(wrapper)
        } else if node.is_compound() {
            if let Some(init) = &node.initial {
                let child_val = Self::resolve_initial_node(&node.states, init, effects);
                let mut wrapper = BTreeMap::new();
                wrapper.insert(node_id.to_string(), child_val);
                StateValue::Compound(wrapper)
            } else {
                StateValue::leaf(node_id)
            }
        } else {
            StateValue::leaf(node_id)
        }
    }

    pub fn resolve_transitions_for_event(
        machine: &MachineDefinition,
        current_state: &StateValue,
        event: &str,
    ) -> Vec<MatchedTransition> {
        let mut results = Vec::new();
        Self::find_transitions_in_state(&machine.states, current_state, event, &[], &mut results);
        results
    }

    fn find_transitions_in_state(
        states: &BTreeMap<String, StateDefinition>,
        state_val: &StateValue,
        event: &str,
        current_path: &[String],
        results: &mut Vec<MatchedTransition>,
    ) {
        match state_val {
            StateValue::Leaf(name) => {
                let mut path = current_path.to_vec();
                path.push(name.clone());

                if let Some(node) = states.get(name) {
                    if let Some(tv) = node.on.get(event) {
                        for detail in Self::transition_value_to_details(tv) {
                            let pol = detail.to_partial_policy();
                            results.push(MatchedTransition {
                                source_path: path.clone(),
                                edge: detail,
                                policy: pol,
                            });
                        }
                    }
                }
            }
            StateValue::Compound(map) => {
                for (parent_name, child_val) in map {
                    let mut next_path = current_path.to_vec();
                    next_path.push(parent_name.clone());

                    if let Some(parent_def) = states.get(parent_name) {
                        // Check children first
                        Self::find_transitions_in_state(&parent_def.states, child_val, event, &next_path, results);

                        // If not handled by children, bubble to parent!
                        if results.is_empty() {
                            if let Some(tv) = parent_def.on.get(event) {
                                for detail in Self::transition_value_to_details(tv) {
                                    let pol = detail.to_partial_policy();
                                    results.push(MatchedTransition {
                                        source_path: next_path.clone(),
                                        edge: detail,
                                        policy: pol,
                                    });
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    fn transition_value_to_details(tv: &TransitionValue) -> Vec<TransitionDetails> {
        match tv {
            TransitionValue::Target(tgt) => vec![TransitionDetails {
                target: Some(tgt.clone()),
                ..Default::default()
            }],
            TransitionValue::Detailed(d) => vec![d.clone()],
            TransitionValue::Multiple(v) => v.clone(),
        }
    }

    pub fn resolve_target_path(
        machine: &MachineDefinition,
        source_path: &[String],
        target_ref: &str,
    ) -> Vec<String> {
        let clean_ref = target_ref.trim_start_matches('#');
        if machine.states.contains_key(clean_ref) {
            return vec![clean_ref.to_string()];
        }
        for i in (0..source_path.len()).rev() {
            let mut candidate = source_path[..i].to_vec();
            candidate.push(clean_ref.to_string());
            if Self::get_node_by_path(machine, &candidate).is_some() {
                return candidate;
            }
        }
        if let Some(found) = Self::find_path_recursive(&machine.states, clean_ref, &[]) {
            return found;
        }
        vec![clean_ref.to_string()]
    }

    pub fn get_node_by_path<'a>(
        machine: &'a MachineDefinition,
        path: &[String],
    ) -> Option<&'a StateDefinition> {
        if path.is_empty() {
            return None;
        }
        let mut cur = machine.states.get(&path[0])?;
        for seg in &path[1..] {
            cur = cur.states.get(seg)?;
        }
        Some(cur)
    }

    fn find_path_recursive(
        states: &BTreeMap<String, StateDefinition>,
        target: &str,
        prefix: &[String],
    ) -> Option<Vec<String>> {
        for (k, v) in states {
            let mut cur = prefix.to_vec();
            cur.push(k.clone());
            if k == target {
                return Some(cur);
            }
            if let Some(found) = Self::find_path_recursive(&v.states, target, &cur) {
                return Some(found);
            }
        }
        None
    }

    pub fn apply_target_transition(
        machine: &MachineDefinition,
        current_state: &StateValue,
        source_path: &[String],
        target_name: &str,
    ) -> AppliedTransition {
        let target_path = Self::resolve_target_path(machine, source_path, target_name);
        let mut exit_effects = Vec::new();
        let mut entry_effects = Vec::new();

        // Calculate LCA common length
        let mut common_len = 0;
        let max_common = source_path.len().min(target_path.len()).saturating_sub(1);
        while common_len < max_common && source_path[common_len] == target_path[common_len] {
            common_len += 1;
        }

        Self::collect_exit_effects(&machine.states, current_state, &mut exit_effects);

        let target_leaf = target_path.last().unwrap();
        let target_node = Self::get_node_by_path(machine, &target_path);

        let target_subval = if let Some(tn) = target_node {
            entry_effects.extend(tn.entry.clone());
            if tn.is_parallel() {
                let mut regions = BTreeMap::new();
                for (region_id, region_def) in &tn.states {
                    if let Some(init) = &region_def.initial {
                        let child_val = Self::resolve_initial_node(&region_def.states, init, &mut entry_effects);
                        regions.insert(region_id.clone(), child_val);
                    }
                }
                StateValue::Compound(regions)
            } else if tn.is_compound() {
                if let Some(init) = &tn.initial {
                    Self::resolve_initial_node(&tn.states, init, &mut entry_effects)
                } else {
                    StateValue::leaf(target_leaf)
                }
            } else {
                StateValue::leaf(target_leaf)
            }
        } else {
            StateValue::leaf(target_leaf)
        };

        let mut built_branch = if target_subval.is_leaf() && target_subval.matches_string(target_leaf) {
            StateValue::leaf(target_leaf)
        } else {
            let mut m = BTreeMap::new();
            m.insert(target_leaf.clone(), target_subval);
            StateValue::Compound(m)
        };

        // Wrap from target_path[len-2] down to common_len
        for i in (common_len..target_path.len().saturating_sub(1)).rev() {
            let anc_key = &target_path[i];
            let anc_path = &target_path[..=i];
            let anc_node = Self::get_node_by_path(machine, anc_path);

            if let Some(node) = anc_node {
                if node.is_parallel() {
                    let mut existing_regions = Self::extract_regions(current_state, anc_path);
                    let region_key = &target_path[i + 1];
                    let region_val = match built_branch {
                        StateValue::Compound(mut m) => m.remove(region_key).unwrap_or(StateValue::Compound(m)),
                        other => other,
                    };
                    existing_regions.insert(region_key.clone(), region_val);
                    let mut wrap = BTreeMap::new();
                    wrap.insert(anc_key.clone(), StateValue::Compound(existing_regions));
                    built_branch = StateValue::Compound(wrap);
                    continue;
                }
            }

            let mut wrap = BTreeMap::new();
            wrap.insert(anc_key.clone(), built_branch);
            built_branch = StateValue::Compound(wrap);
        }

        let next_state = if common_len == 0 {
            built_branch
        } else {
            Self::replace_at_lca(current_state, &target_path[..common_len], built_branch)
        };

        AppliedTransition {
            next_state_value: next_state,
            exit_effects,
            entry_effects,
        }
    }

    fn extract_regions(current_state: &StateValue, anc_path: &[String]) -> BTreeMap<String, StateValue> {
        let mut cur = current_state;
        for seg in anc_path {
            match cur {
                StateValue::Compound(m) => {
                    if let Some(next) = m.get(seg) {
                        cur = next;
                    } else {
                        return BTreeMap::new();
                    }
                }
                _ => return BTreeMap::new(),
            }
        }
        match cur {
            StateValue::Compound(m) => m.clone(),
            _ => BTreeMap::new(),
        }
    }

    fn replace_at_lca(
        current_state: &StateValue,
        lca_path: &[String],
        new_branch: StateValue,
    ) -> StateValue {
        if lca_path.is_empty() {
            return new_branch;
        }
        match current_state {
            StateValue::Compound(map) => {
                let mut next_map = map.clone();
                let head = &lca_path[0];
                if let Some(child) = map.get(head) {
                    let updated = Self::replace_at_lca(child, &lca_path[1..], new_branch);
                    next_map.insert(head.clone(), updated);
                } else {
                    next_map.insert(head.clone(), new_branch);
                }
                StateValue::Compound(next_map)
            }
            StateValue::Leaf(name) => {
                let mut map = BTreeMap::new();
                map.insert(name.clone(), new_branch);
                StateValue::Compound(map)
            }
        }
    }

    fn collect_exit_effects(
        states: &BTreeMap<String, StateDefinition>,
        state_val: &StateValue,
        effects: &mut Vec<String>,
    ) {
        match state_val {
            StateValue::Leaf(name) => {
                if let Some(node) = states.get(name) {
                    effects.extend(node.exit.clone());
                }
            }
            StateValue::Compound(map) => {
                for (parent_name, child_val) in map {
                    if let Some(parent_def) = states.get(parent_name) {
                        Self::collect_exit_effects(&parent_def.states, child_val, effects);
                        effects.extend(parent_def.exit.clone());
                    }
                }
            }
        }
    }

    pub fn find_pending_on_done(
        machine: &MachineDefinition,
        current_state: &StateValue,
    ) -> Option<PendingOnDone> {
        Self::check_on_done_recursive(&machine.states, current_state, &[])
    }

    fn check_on_done_recursive(
        states: &BTreeMap<String, StateDefinition>,
        state_val: &StateValue,
        current_path: &[String],
    ) -> Option<PendingOnDone> {
        match state_val {
            StateValue::Leaf(_) => None,
            StateValue::Compound(map) => {
                for (parent_name, child_val) in map {
                    let mut path = current_path.to_vec();
                    path.push(parent_name.clone());

                    if let Some(parent_def) = states.get(parent_name) {
                        if let Some(res) = Self::check_on_done_recursive(&parent_def.states, child_val, &path) {
                            return Some(res);
                        }

                        if Self::is_state_complete(&parent_def, child_val) {
                            if let Some(ref on_done) = parent_def.on_done {
                                let details = match on_done {
                                    OnDoneValue::Target(t) => TransitionDetails {
                                        target: Some(t.clone()),
                                        ..Default::default()
                                    },
                                    OnDoneValue::Detailed(d) => d.clone(),
                                    OnDoneValue::Multiple(v) => v.first().cloned().unwrap_or_default(),
                                };
                                return Some(PendingOnDone {
                                    source_path: path,
                                    edge: details,
                                });
                            }
                        }
                    }
                }
                None
            }
        }
    }

    fn is_state_complete(parent_def: &StateDefinition, child_val: &StateValue) -> bool {
        if parent_def.is_parallel() {
            if let StateValue::Compound(regions) = child_val {
                if regions.is_empty() {
                    return false;
                }
                for (reg_id, reg_val) in regions {
                    if let Some(reg_def) = parent_def.states.get(reg_id) {
                        if !Self::is_substate_final(reg_def, reg_val) {
                            return false;
                        }
                    }
                }
                return true;
            }
            false
        } else if parent_def.is_compound() {
            Self::is_substate_final(parent_def, child_val)
        } else {
            false
        }
    }

    fn is_substate_final(node_def: &StateDefinition, state_val: &StateValue) -> bool {
        match state_val {
            StateValue::Leaf(name) => {
                if let Some(child_def) = node_def.states.get(name) {
                    child_def.is_final()
                } else {
                    false
                }
            }
            StateValue::Compound(map) => {
                for (k, v) in map {
                    if let Some(child_def) = node_def.states.get(k) {
                        if Self::is_substate_final(child_def, v) {
                            return true;
                        }
                    }
                }
                false
            }
        }
    }

    pub fn get_available_events(machine: &MachineDefinition, current_state: &StateValue) -> Vec<String> {
        let mut events = Vec::new();
        Self::collect_available_events(&machine.states, current_state, &mut events);
        events.sort();
        events.dedup();
        events
    }

    fn collect_available_events(
        states: &BTreeMap<String, StateDefinition>,
        state_val: &StateValue,
        events: &mut Vec<String>,
    ) {
        match state_val {
            StateValue::Leaf(name) => {
                if let Some(node) = states.get(name) {
                    events.extend(node.on.keys().cloned());
                }
            }
            StateValue::Compound(map) => {
                for (parent_name, child_val) in map {
                    if let Some(parent_def) = states.get(parent_name) {
                        events.extend(parent_def.on.keys().cloned());
                        Self::collect_available_events(&parent_def.states, child_val, events);
                    }
                }
            }
        }
    }

    pub fn get_terminal_states(machine: &MachineDefinition) -> Vec<String> {
        let mut list = Vec::new();
        for (k, v) in &machine.states {
            if v.is_final() {
                list.push(k.clone());
            }
        }
        if !list.contains(&"error".to_string()) && machine.states.contains_key("error") {
            list.push("error".to_string());
        }
        list.sort();
        list
    }
}
