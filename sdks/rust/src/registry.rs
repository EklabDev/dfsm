use crate::clock::{Clock, RealClock};
use crate::definition::MachineDefinition;
use crate::error::DfsmError;
use crate::policy::PartialTransitionPolicy;
use crate::state_value::StateValue;
use crate::store::memory::MemoryStateStore;
use crate::store::StateStore;
use crate::telemetry::{BenchmarkEngine, ConsoleBenchmarkEngine};
use crate::types::{CompensationRequest, EffectRequest, HookType};
use futures_util::future::BoxFuture;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};

pub type TransitionHandlerFn = Arc<
    dyn Fn(
            String, // tx_id
            serde_json::Value, // context
            Option<serde_json::Value>, // input
            StateValue, // current_state
            String, // event_name
        ) -> BoxFuture<'static, Result<(Option<serde_json::Value>, Option<serde_json::Value>), DfsmError>>
        + Send
        + Sync,
>;

pub type CompensateHandlerFn =
    Arc<dyn Fn(CompensationRequest<serde_json::Value>) -> BoxFuture<'static, ()> + Send + Sync>;

pub type EffectHandlerFn =
    Arc<dyn Fn(EffectRequest<serde_json::Value>) -> BoxFuture<'static, Result<(), DfsmError>> + Send + Sync>;

pub type HookHandlerFn = Arc<dyn Fn(serde_json::Value) -> BoxFuture<'static, ()> + Send + Sync>;

#[derive(Clone)]
pub struct RegisteredTransition {
    pub handler: TransitionHandlerFn,
    pub policy: Option<PartialTransitionPolicy>,
}

pub struct FSMRegistry {
    machines: RwLock<HashMap<String, MachineDefinition>>,
    transitions: RwLock<HashMap<String, RegisteredTransition>>,
    compensations: RwLock<HashMap<String, CompensateHandlerFn>>,
    effects: RwLock<HashMap<String, EffectHandlerFn>>,
    hooks: RwLock<HashMap<HookType, Vec<HookHandlerFn>>>,
    pub store: Arc<dyn StateStore>,
    pub benchmark: Arc<dyn BenchmarkEngine>,
    pub clock: Arc<dyn Clock>,
    pub global_policy: Option<PartialTransitionPolicy>,
}

impl Default for FSMRegistry {
    fn default() -> Self {
        Self {
            machines: RwLock::new(HashMap::new()),
            transitions: RwLock::new(HashMap::new()),
            compensations: RwLock::new(HashMap::new()),
            effects: RwLock::new(HashMap::new()),
            hooks: RwLock::new(HashMap::new()),
            store: Arc::new(MemoryStateStore::new()),
            benchmark: Arc::new(ConsoleBenchmarkEngine),
            clock: Arc::new(RealClock),
            global_policy: None,
        }
    }
}

impl FSMRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_store(mut self, store: Arc<dyn StateStore>) -> Self {
        self.store = store;
        self
    }

    pub fn with_benchmark(mut self, benchmark: Arc<dyn BenchmarkEngine>) -> Self {
        self.benchmark = benchmark;
        self
    }

    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    pub fn register_machine(&self, machine: MachineDefinition) {
        let mut m = self.machines.write().unwrap();
        m.insert(machine.id.clone(), machine);
    }

    pub fn get_machine(&self, id: &str) -> Option<MachineDefinition> {
        self.machines.read().unwrap().get(id).cloned()
    }

    pub fn register_transition(
        &self,
        name: &str,
        handler: Box<
            dyn Fn(
                    String,
                    serde_json::Value,
                    Option<serde_json::Value>,
                    StateValue,
                    String,
                )
                    -> BoxFuture<'static, Result<(Option<serde_json::Value>, Option<serde_json::Value>), DfsmError>>
                + Send
                + Sync,
        >,
        policy: Option<PartialTransitionPolicy>,
    ) {
        let mut t = self.transitions.write().unwrap();
        t.insert(
            name.to_string(),
            RegisteredTransition {
                handler: Arc::from(handler),
                policy,
            },
        );
    }

    pub fn register_compensate(
        &self,
        name: &str,
        handler: Box<dyn Fn(CompensationRequest<serde_json::Value>) -> BoxFuture<'static, ()> + Send + Sync>,
    ) {
        let mut c = self.compensations.write().unwrap();
        c.insert(name.to_string(), Arc::from(handler));
    }

    pub fn register_effect(
        &self,
        name: &str,
        handler: Box<dyn Fn(EffectRequest<serde_json::Value>) -> BoxFuture<'static, Result<(), DfsmError>> + Send + Sync>,
    ) {
        let mut e = self.effects.write().unwrap();
        e.insert(name.to_string(), Arc::from(handler));
    }

    pub fn register_hook(
        &self,
        hook_type: HookType,
        handler: Box<dyn Fn(serde_json::Value) -> BoxFuture<'static, ()> + Send + Sync>,
    ) {
        let mut h = self.hooks.write().unwrap();
        h.entry(hook_type).or_default().push(Arc::from(handler));
    }

    pub fn register_on_start(
        &self,
        handler: Box<dyn Fn(serde_json::Value) -> BoxFuture<'static, ()> + Send + Sync>,
    ) {
        self.register_hook(HookType::OnStart, handler);
    }

    pub fn register_before_transition(
        &self,
        handler: Box<dyn Fn(serde_json::Value) -> BoxFuture<'static, ()> + Send + Sync>,
    ) {
        self.register_hook(HookType::BeforeTransition, handler);
    }

    pub fn register_after_transition(
        &self,
        handler: Box<dyn Fn(serde_json::Value) -> BoxFuture<'static, ()> + Send + Sync>,
    ) {
        self.register_hook(HookType::AfterTransition, handler);
    }

    pub fn register_on_compensate(
        &self,
        handler: Box<dyn Fn(serde_json::Value) -> BoxFuture<'static, ()> + Send + Sync>,
    ) {
        self.register_hook(HookType::OnCompensate, handler);
    }

    pub fn register_on_complete(
        &self,
        handler: Box<dyn Fn(serde_json::Value) -> BoxFuture<'static, ()> + Send + Sync>,
    ) {
        self.register_hook(HookType::OnComplete, handler);
    }

    pub fn register_on_terminal(
        &self,
        handler: Box<dyn Fn(serde_json::Value) -> BoxFuture<'static, ()> + Send + Sync>,
    ) {
        self.register_hook(HookType::OnTerminal, handler);
    }

    pub fn find_transition(&self, name: &str) -> Option<RegisteredTransition> {
        let t = self.transitions.read().unwrap();
        if let Some(reg) = t.get(name) {
            return Some(reg.clone());
        }
        if let Some(pos) = name.rfind('.') {
            let unqualified = &name[pos + 1..];
            if let Some(reg) = t.get(unqualified) {
                return Some(reg.clone());
            }
        } else {
            let suffix = format!(".{}", name);
            for (k, v) in t.iter() {
                if k.ends_with(&suffix) {
                    return Some(v.clone());
                }
            }
        }
        None
    }

    pub fn find_compensate(&self, name: &str) -> Option<CompensateHandlerFn> {
        let c = self.compensations.read().unwrap();
        if let Some(h) = c.get(name) {
            return Some(h.clone());
        }
        if let Some(pos) = name.rfind('.') {
            let unqualified = &name[pos + 1..];
            if let Some(h) = c.get(unqualified) {
                return Some(h.clone());
            }
        } else {
            let suffix = format!(".{}", name);
            for (k, v) in c.iter() {
                if k.ends_with(&suffix) {
                    return Some(v.clone());
                }
            }
        }
        None
    }

    pub fn find_effect(&self, name: &str) -> Option<EffectHandlerFn> {
        let e = self.effects.read().unwrap();
        if let Some(h) = e.get(name) {
            return Some(h.clone());
        }
        if let Some(pos) = name.rfind('.') {
            let unqualified = &name[pos + 1..];
            if let Some(h) = e.get(unqualified) {
                return Some(h.clone());
            }
        } else {
            let suffix = format!(".{}", name);
            for (k, v) in e.iter() {
                if k.ends_with(&suffix) {
                    return Some(v.clone());
                }
            }
        }
        None
    }

    pub fn get_hooks(&self, hook_type: HookType) -> Vec<HookHandlerFn> {
        let h = self.hooks.read().unwrap();
        h.get(&hook_type).cloned().unwrap_or_default()
    }
}
