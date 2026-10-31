use crate::error::DfsmError;
use crate::policy::PartialTransitionPolicy;
use jsonschema::JSONSchema;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

static COMPILED_SCHEMA: OnceLock<JSONSchema> = OnceLock::new();

fn get_schema() -> &'static JSONSchema {
    COMPILED_SCHEMA.get_or_init(|| {
        let schema_str = include_str!("../schemas/dfsm-v1.schema.json");
        let schema_json: serde_json::Value =
            serde_json::from_str(schema_str).expect("Embedded schema JSON is valid");
        JSONSchema::compile(&schema_json).expect("Embedded schema must compile")
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryConfig {
    #[serde(default)]
    pub namespace: Option<String>,
    #[serde(default)]
    pub strict: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineDefinition {
    pub id: String,
    pub dfsm: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(rename = "type", default)]
    pub machine_type: Option<String>,
    pub initial: String,
    #[serde(default = "default_chain_depth")]
    pub max_effect_chain_depth: usize,
    pub states: BTreeMap<String, StateDefinition>,
    #[serde(default)]
    pub defaults: Option<PartialTransitionPolicy>,
    #[serde(default)]
    pub registry: Option<RegistryConfig>,
    #[serde(default)]
    pub hooks: Option<serde_json::Value>,
    #[serde(default)]
    pub effects: Option<Vec<String>>,
}

fn default_chain_depth() -> usize {
    25
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateDefinition {
    #[serde(rename = "type", default)]
    pub state_type: Option<String>,
    #[serde(default)]
    pub initial: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub states: BTreeMap<String, StateDefinition>,
    #[serde(default)]
    pub on: BTreeMap<String, TransitionValue>,
    #[serde(default)]
    pub on_done: Option<OnDoneValue>,
    #[serde(default)]
    pub entry: Vec<String>,
    #[serde(default)]
    pub exit: Vec<String>,
}

impl StateDefinition {
    pub fn is_compound(&self) -> bool {
        !self.states.is_empty() && self.state_type.as_deref() != Some("parallel")
    }

    pub fn is_parallel(&self) -> bool {
        self.state_type.as_deref() == Some("parallel")
    }

    pub fn is_final(&self) -> bool {
        self.state_type.as_deref() == Some("final")
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TransitionValue {
    Target(String),
    Detailed(TransitionDetails),
    Multiple(Vec<TransitionDetails>),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum OnDoneValue {
    Target(String),
    Detailed(TransitionDetails),
    Multiple(Vec<TransitionDetails>),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TransitionDetails {
    pub target: Option<String>,
    pub transition: Option<String>,
    pub compensate: Option<String>,
    #[serde(default)]
    pub retry: Option<serde_json::Value>,
    #[serde(default)]
    pub circuit_breaker: Option<serde_json::Value>,
    #[serde(default)]
    pub on_fail: Option<serde_json::Value>,
    #[serde(default)]
    pub effects: Vec<String>,
}

impl TransitionDetails {
    pub fn to_partial_policy(&self) -> Option<PartialTransitionPolicy> {
        let mut map = serde_json::Map::new();
        if let Some(r) = &self.retry {
            map.insert("retry".to_string(), r.clone());
        }
        if let Some(cb) = &self.circuit_breaker {
            map.insert("circuitBreaker".to_string(), cb.clone());
        }
        if let Some(of) = &self.on_fail {
            map.insert("onFail".to_string(), of.clone());
        }
        if let Some(c) = &self.compensate {
            map.insert(
                "compensateWith".to_string(),
                serde_json::Value::String(c.clone()),
            );
        }
        if map.is_empty() {
            None
        } else {
            Some(PartialTransitionPolicy::from_value(
                &serde_json::Value::Object(map),
            ))
        }
    }
}

pub fn qualify(name: &str, ns: &str) -> String {
    if ns.is_empty() || name.is_empty() || name.contains('.') {
        name.to_string()
    } else {
        format!("{}.{}", ns, name)
    }
}

fn qualify_state(state: &mut StateDefinition, ns: &str) {
    for e in &mut state.entry {
        *e = qualify(e, ns);
    }
    for ex in &mut state.exit {
        *ex = qualify(ex, ns);
    }
    for transitions in state.on.values_mut() {
        match transitions {
            TransitionValue::Detailed(d) => qualify_details(d, ns),
            TransitionValue::Multiple(list) => {
                for d in list {
                    qualify_details(d, ns);
                }
            }
            TransitionValue::Target(_) => {}
        }
    }
    if let Some(on_done) = &mut state.on_done {
        match on_done {
            OnDoneValue::Detailed(d) => qualify_details(d, ns),
            OnDoneValue::Multiple(list) => {
                for d in list {
                    qualify_details(d, ns);
                }
            }
            OnDoneValue::Target(_) => {}
        }
    }
    for child in state.states.values_mut() {
        qualify_state(child, ns);
    }
}

fn qualify_details(d: &mut TransitionDetails, ns: &str) {
    if let Some(tr) = &mut d.transition {
        *tr = qualify(tr, ns);
    }
    if let Some(comp) = &mut d.compensate {
        *comp = qualify(comp, ns);
    }
    for eff in &mut d.effects {
        *eff = qualify(eff, ns);
    }
}

pub fn parse_yaml_machine(yaml_str: &str) -> Result<MachineDefinition, DfsmError> {
    let raw_val: serde_json::Value = serde_yaml::from_str(yaml_str)
        .map_err(|e| DfsmError::YamlParseError(e.to_string()))?;

    let schema = get_schema();
    if let Err(errors) = schema.validate(&raw_val) {
        let err_msgs: Vec<String> = errors.map(|e| e.to_string()).collect();
        return Err(DfsmError::SchemaValidationFailed(format!(
            "DFSM YAML failed JSON Schema validation: {}",
            err_msgs.join("; ")
        )));
    }

    let mut machine: MachineDefinition = serde_json::from_value(raw_val)
        .map_err(|e| DfsmError::YamlParseError(format!("Failed to deserialize AST: {}", e)))?;

    if machine.max_effect_chain_depth == 0 {
        machine.max_effect_chain_depth = 25;
    }

    // Apply namespace qualification if present
    if let Some(reg) = &machine.registry {
        if let Some(ns) = &reg.namespace {
            if !ns.is_empty() {
                for state in machine.states.values_mut() {
                    qualify_state(state, ns);
                }
                if let Some(effects) = &mut machine.effects {
                    for eff in effects {
                        *eff = qualify(eff, ns);
                    }
                }
            }
        }
    }

    Ok(machine)
}
