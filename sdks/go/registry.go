package dfsm

import (
	"strings"
	"sync"
)

type FSMRegistry struct {
	mu           sync.RWMutex
	machines     map[string]*MachineDefinition
	transitions  map[string]registeredTransition
	compensations map[string]any
	effects      map[string]any
	hooks        map[HookType][]any
	Store        StateStore
	Benchmark    BenchmarkLogEngine
	Clock        Clock
	Validator    SchemaValidator
	GlobalPolicy *PartialTransitionPolicy
}

type registeredTransition struct {
	Handler any
	Policy  *PartialTransitionPolicy
}

func NewFSMRegistry(opts ...RegistryOption) *FSMRegistry {
	r := &FSMRegistry{
		machines:      make(map[string]*MachineDefinition),
		transitions:   make(map[string]registeredTransition),
		compensations: make(map[string]any),
		effects:       make(map[string]any),
		hooks:         make(map[HookType][]any),
		Store:         NewMemoryStateStore(),
		Benchmark:     ConsoleBenchmarkLogEngine{},
		Clock:         RealClock{},
		Validator:     StructTagValidator{},
	}
	for _, opt := range opts {
		opt(r)
	}
	return r
}

type RegistryOption func(*FSMRegistry)

func WithStore(store StateStore) RegistryOption {
	return func(r *FSMRegistry) {
		r.Store = store
	}
}

func WithBenchmark(b BenchmarkLogEngine) RegistryOption {
	return func(r *FSMRegistry) {
		r.Benchmark = b
	}
}

func WithClock(c Clock) RegistryOption {
	return func(r *FSMRegistry) {
		r.Clock = c
	}
}

func WithValidator(v SchemaValidator) RegistryOption {
	return func(r *FSMRegistry) {
		r.Validator = v
	}
}

func (r *FSMRegistry) RegisterMachine(m *MachineDefinition) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.machines[m.Id] = m
}

func (r *FSMRegistry) GetMachine(id string) *MachineDefinition {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.machines[id]
}

func (r *FSMRegistry) RegisterTransition(name string, handler any, policy *PartialTransitionPolicy) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.transitions[name] = registeredTransition{Handler: handler, Policy: policy}
}

func (r *FSMRegistry) GetTransition(name string) (any, *PartialTransitionPolicy, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if t, ok := r.transitions[name]; ok {
		return t.Handler, t.Policy, true
	}
	dot := strings.LastIndex(name, ".")
	if dot >= 0 {
		unqualified := name[dot+1:]
		if t, ok := r.transitions[unqualified]; ok {
			return t.Handler, t.Policy, true
		}
	}
	return nil, nil, false
}

func (r *FSMRegistry) RegisterCompensate(name string, handler any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.compensations[name] = handler
}

func (r *FSMRegistry) GetCompensate(name string) (any, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if h, ok := r.compensations[name]; ok {
		return h, true
	}
	dot := strings.LastIndex(name, ".")
	if dot >= 0 {
		unqualified := name[dot+1:]
		if h, ok := r.compensations[unqualified]; ok {
			return h, true
		}
	}
	return nil, false
}

func (r *FSMRegistry) RegisterEffect(name string, handler any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.effects[name] = handler
}

func (r *FSMRegistry) GetEffect(name string) (any, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	if h, ok := r.effects[name]; ok {
		return h, true
	}
	dot := strings.LastIndex(name, ".")
	if dot >= 0 {
		unqualified := name[dot+1:]
		if h, ok := r.effects[unqualified]; ok {
			return h, true
		}
	}
	return nil, false
}

func (r *FSMRegistry) RegisterHook(hookType HookType, handler any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.hooks[hookType] = append(r.hooks[hookType], handler)
}

func (r *FSMRegistry) RegisterOnStart(handler any) {
	r.RegisterHook(HookOnStart, handler)
}

func (r *FSMRegistry) RegisterBeforeTransition(handler any) {
	r.RegisterHook(HookBeforeTransition, handler)
}

func (r *FSMRegistry) RegisterAfterTransition(handler any) {
	r.RegisterHook(HookAfterTransition, handler)
}

func (r *FSMRegistry) RegisterOnCompensate(handler any) {
	r.RegisterHook(HookOnCompensate, handler)
}

func (r *FSMRegistry) RegisterOnComplete(handler any) {
	r.RegisterHook(HookOnComplete, handler)
}

func (r *FSMRegistry) RegisterOnTerminal(handler any) {
	r.RegisterHook(HookOnTerminal, handler)
}

func (r *FSMRegistry) GetHooks(hookType HookType) []any {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return append([]any{}, r.hooks[hookType]...)
}
