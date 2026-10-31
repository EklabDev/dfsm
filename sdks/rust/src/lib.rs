pub mod actor;
pub mod circuit_breaker;
pub mod clock;
pub mod definition;
pub mod error;
pub mod policy;
pub mod registry;
pub mod state_value;
pub mod statechart;
pub mod store;
pub mod telemetry;
pub mod types;

// Re-exports
pub use actor::DfsmActor;
pub use circuit_breaker::{CircuitBreakerInstance, CircuitState};
pub use clock::{Clock, RealClock, VirtualClock};
pub use definition::{parse_yaml_machine, MachineDefinition, StateDefinition};
pub use error::DfsmError;
pub use policy::{
    BenchmarkPolicy, CircuitBreakerPolicy, OnFailPolicy, PartialTransitionPolicy, PolicyMerger,
    RetryPolicy, TransitionPolicy,
};
pub use registry::FSMRegistry;
pub use state_value::StateValue;
pub use statechart::StatechartEngine;
pub use store::memory::MemoryStateStore;
pub use store::StateStore;
pub use telemetry::{BenchmarkEngine, BenchmarkEvent, ConsoleBenchmarkEngine};
pub use types::*;

