package dfsm

type MachineBuilder[TContext any] struct {
	machine *MachineDefinition
}

func NewMachineBuilder[TContext any](id string) *MachineBuilder[TContext] {
	return &MachineBuilder[TContext]{
		machine: &MachineDefinition{
			Id:                  id,
			Dfsm:                "1.0",
			MaxEffectChainDepth: 25,
			States:              make(map[string]*StateDefinition),
		},
	}
}

func (b *MachineBuilder[TContext]) Initial(initial string) *MachineBuilder[TContext] {
	b.machine.Initial = initial
	return b
}

func (b *MachineBuilder[TContext]) Description(desc string) *MachineBuilder[TContext] {
	b.machine.Description = desc
	return b
}

func (b *MachineBuilder[TContext]) MaxEffectChainDepth(depth int) *MachineBuilder[TContext] {
	b.machine.MaxEffectChainDepth = depth
	return b
}

func (b *MachineBuilder[TContext]) State(name string, configFn func(s *StateBuilder[TContext])) *MachineBuilder[TContext] {
	sb := &StateBuilder[TContext]{
		state: &StateDefinition{
			Id:     name,
			States: make(map[string]*StateDefinition),
			On:     make(map[string][]TransitionDefinition),
		},
	}
	configFn(sb)
	b.machine.States[name] = sb.state
	return b
}

func (b *MachineBuilder[TContext]) Build() *MachineDefinition {
	if _, ok := b.machine.States["error"]; !ok {
		b.machine.States["error"] = &StateDefinition{
			Id:   "error",
			Type: "final",
		}
	}
	return b.machine
}

type StateBuilder[TContext any] struct {
	state *StateDefinition
}

func (s *StateBuilder[TContext]) Type(t string) *StateBuilder[TContext] {
	s.state.Type = t
	return s
}

func (s *StateBuilder[TContext]) Initial(init string) *StateBuilder[TContext] {
	s.state.Initial = init
	return s
}

func (s *StateBuilder[TContext]) Entry(effects ...string) *StateBuilder[TContext] {
	s.state.Entry = append(s.state.Entry, effects...)
	return s
}

func (s *StateBuilder[TContext]) Exit(effects ...string) *StateBuilder[TContext] {
	s.state.Exit = append(s.state.Exit, effects...)
	return s
}

func (s *StateBuilder[TContext]) On(eventName string, target string, opts ...func(*TransitionDefinition)) *StateBuilder[TContext] {
	td := TransitionDefinition{Target: target}
	for _, opt := range opts {
		opt(&td)
	}
	s.state.On[eventName] = append(s.state.On[eventName], td)
	return s
}

func (s *StateBuilder[TContext]) OnDone(target string, opts ...func(*TransitionDefinition)) *StateBuilder[TContext] {
	td := TransitionDefinition{Target: target}
	for _, opt := range opts {
		opt(&td)
	}
	s.state.OnDone = append(s.state.OnDone, td)
	return s
}

func (s *StateBuilder[TContext]) State(name string, configFn func(child *StateBuilder[TContext])) *StateBuilder[TContext] {
	child := &StateBuilder[TContext]{
		state: &StateDefinition{
			Id:     name,
			States: make(map[string]*StateDefinition),
			On:     make(map[string][]TransitionDefinition),
		},
	}
	configFn(child)
	s.state.States[name] = child.state
	return s
}

func WithHandler(handler string) func(*TransitionDefinition) {
	return func(t *TransitionDefinition) {
		t.Handler = handler
	}
}

func WithPolicy(p *PartialTransitionPolicy) func(*TransitionDefinition) {
	return func(t *TransitionDefinition) {
		t.Policy = p
	}
}

