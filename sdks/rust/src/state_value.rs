use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StateValue {
    Leaf(String),
    Compound(BTreeMap<String, StateValue>),
}

impl StateValue {
    pub fn leaf(name: impl Into<String>) -> Self {
        StateValue::Leaf(name.into())
    }

    pub fn compound(map: BTreeMap<String, StateValue>) -> Self {
        StateValue::Compound(map)
    }

    pub fn is_leaf(&self) -> bool {
        matches!(self, StateValue::Leaf(_))
    }

    pub fn is_compound(&self) -> bool {
        matches!(self, StateValue::Compound(_))
    }

    pub fn matches_string(&self, s: &str) -> bool {
        match self {
            StateValue::Leaf(name) => name == s,
            StateValue::Compound(_) => false,
        }
    }
}

impl fmt::Display for StateValue {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StateValue::Leaf(s) => write!(f, "{}", s),
            StateValue::Compound(_map) => {
                let json = serde_json::to_string(self).unwrap_or_else(|_| "{}".to_string());
                write!(f, "{}", json)
            }
        }
    }
}

impl Serialize for StateValue {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            StateValue::Leaf(s) => serializer.serialize_str(s),
            StateValue::Compound(map) => map.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for StateValue {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let val = serde_json::Value::deserialize(deserializer)?;
        match val {
            serde_json::Value::String(s) => Ok(StateValue::Leaf(s)),
            serde_json::Value::Object(map) => {
                let mut btree = BTreeMap::new();
                for (k, v) in map {
                    let sv: StateValue = serde_json::from_value(v).map_err(serde::de::Error::custom)?;
                    btree.insert(k, sv);
                }
                Ok(StateValue::Compound(btree))
            }
            _ => Err(serde::de::Error::custom("expected string or object for StateValue")),
        }
    }
}
