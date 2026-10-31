package dfsm

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/santhosh-tekuri/jsonschema/v5"
	"gopkg.in/yaml.v3"
)

//go:embed schemas/dfsm-v1.schema.json
var embeddedSchemaBytes []byte

var compiledSchema *jsonschema.Schema

func init() {
	compiler := jsonschema.NewCompiler()
	compiler.Draft = jsonschema.Draft2020
	if err := compiler.AddResource("dfsm-v1.schema.json", strings.NewReader(string(embeddedSchemaBytes))); err == nil {
		compiledSchema, _ = compiler.Compile("dfsm-v1.schema.json")
	}
}

type MachineDefinition struct {
	Id                  string                      `json:"id"`
	Dfsm                string                      `json:"dfsm"`
	Description         string                      `json:"description,omitempty"`
	Type                string                      `json:"type,omitempty"`
	Initial             string                      `json:"initial"`
	MaxEffectChainDepth int                         `json:"maxEffectChainDepth"`
	States              map[string]*StateDefinition `json:"states"`
	Defaults            *PartialTransitionPolicy    `json:"defaults,omitempty"`
	Hooks               []string                    `json:"hooks,omitempty"`
	Effects             []string                    `json:"effects,omitempty"`
}

type StateDefinition struct {
	Id      string                            `json:"id"`
	Type    string                            `json:"type,omitempty"`
	Initial string                            `json:"initial,omitempty"`
	States  map[string]*StateDefinition       `json:"states,omitempty"`
	On      map[string][]TransitionDefinition `json:"on,omitempty"`
	OnDone  []TransitionDefinition            `json:"onDone,omitempty"`
	Entry   []string                          `json:"entry,omitempty"`
	Exit    []string                          `json:"exit,omitempty"`
}

func (s *StateDefinition) IsCompound() bool {
	return strings.EqualFold(s.Type, "compound") || (len(s.States) > 0 && !s.IsParallel())
}

func (s *StateDefinition) IsParallel() bool {
	return strings.EqualFold(s.Type, "parallel")
}

func (s *StateDefinition) IsFinal() bool {
	return strings.EqualFold(s.Type, "final")
}

type TransitionDefinition struct {
	Target  string                   `json:"target"`
	Handler string                   `json:"handler,omitempty"`
	Policy  *PartialTransitionPolicy `json:"policy,omitempty"`
}

func ParseYamlMachine(yamlContent string) (*MachineDefinition, error) {
	if strings.TrimSpace(yamlContent) == "" {
		return nil, ValidationError{Message: "DFSM YAML content cannot be empty"}
	}

	var genericData any
	if err := yaml.Unmarshal([]byte(yamlContent), &genericData); err != nil {
		return nil, ValidationError{Message: fmt.Sprintf("YAML parse error: %v", err)}
	}

	// Normalizing maps from map[any]any to map[string]any for JSON
	genericData = normalizeYamlNode(genericData)

	jsonBytes, err := json.Marshal(genericData)
	if err != nil {
		return nil, ValidationError{Message: fmt.Sprintf("JSON marshal error: %v", err)}
	}

	// JSON Schema validation
	if compiledSchema != nil {
		var jsonDoc any
		_ = json.Unmarshal(jsonBytes, &jsonDoc)
		if err := compiledSchema.Validate(jsonDoc); err != nil {
			return nil, ValidationError{
				Message: fmt.Sprintf("DFSM YAML failed JSON Schema validation: %v", err),
			}
		}
	}

	// Parse into MachineDefinition
	var rawMap map[string]any
	if err := json.Unmarshal(jsonBytes, &rawMap); err != nil {
		return nil, err
	}

	var ns string
	if reg, ok := rawMap["registry"].(map[string]any); ok {
		if n, ok := reg["namespace"].(string); ok {
			ns = n
		}
	}

	machine := &MachineDefinition{
		Id:                  fmt.Sprintf("%v", rawMap["id"]),
		Dfsm:                "1.0",
		MaxEffectChainDepth: 25,
		States:              make(map[string]*StateDefinition),
	}

	if d, ok := rawMap["dfsm"].(string); ok {
		machine.Dfsm = d
	}
	if desc, ok := rawMap["description"].(string); ok {
		machine.Description = desc
	}
	if t, ok := rawMap["type"].(string); ok {
		machine.Type = t
	}
	if init, ok := rawMap["initial"].(string); ok {
		machine.Initial = init
	}
	if md, ok := rawMap["maxEffectChainDepth"].(float64); ok {
		machine.MaxEffectChainDepth = int(md)
	}

	if defs, ok := rawMap["defaults"].(map[string]any); ok {
		machine.Defaults = parsePartialPolicy(defs, ns)
	}

	if hooks, ok := rawMap["hooks"].([]any); ok {
		for _, h := range hooks {
			if s, ok := h.(string); ok {
				machine.Hooks = append(machine.Hooks, qualify(s, ns))
			}
		}
	}

	if effects, ok := rawMap["effects"].([]any); ok {
		for _, e := range effects {
			if s, ok := e.(string); ok {
				machine.Effects = append(machine.Effects, qualify(s, ns))
			}
		}
	}

	if states, ok := rawMap["states"].(map[string]any); ok {
		for name, sVal := range states {
			if sMap, ok := sVal.(map[string]any); ok {
				machine.States[name] = parseStateDef(name, sMap, ns)
			}
		}
	}

	// Implicit error state if omitted
	if _, ok := machine.States["error"]; !ok {
		machine.States["error"] = &StateDefinition{
			Id:   "error",
			Type: "final",
		}
	}

	if err := validateMachineAst(machine); err != nil {
		return nil, err
	}

	return machine, nil
}

func qualify(name string, ns string) string {
	if ns == "" || name == "" {
		return name
	}
	if strings.Contains(name, ".") {
		return name
	}
	return ns + "." + name
}

func normalizeYamlNode(node any) any {
	switch v := node.(type) {
	case map[any]any:
		res := make(map[string]any, len(v))
		for k, child := range v {
			res[fmt.Sprintf("%v", k)] = normalizeYamlNode(child)
		}
		return res
	case map[string]any:
		res := make(map[string]any, len(v))
		for k, child := range v {
			res[k] = normalizeYamlNode(child)
		}
		return res
	case []any:
		res := make([]any, len(v))
		for i, child := range v {
			res[i] = normalizeYamlNode(child)
		}
		return res
	default:
		return v
	}
}

func parseStateDef(id string, data map[string]any, ns string) *StateDefinition {
	s := &StateDefinition{
		Id:     id,
		States: make(map[string]*StateDefinition),
		On:     make(map[string][]TransitionDefinition),
	}

	if t, ok := data["type"].(string); ok {
		s.Type = t
	}
	if init, ok := data["initial"].(string); ok {
		s.Initial = init
	}

	if entry, ok := data["entry"]; ok {
		switch e := entry.(type) {
		case string:
			s.Entry = append(s.Entry, qualify(e, ns))
		case []any:
			for _, item := range e {
				if str, ok := item.(string); ok {
					s.Entry = append(s.Entry, qualify(str, ns))
				}
			}
		}
	}

	if exit, ok := data["exit"]; ok {
		switch e := exit.(type) {
		case string:
			s.Exit = append(s.Exit, qualify(e, ns))
		case []any:
			for _, item := range e {
				if str, ok := item.(string); ok {
					s.Exit = append(s.Exit, qualify(str, ns))
				}
			}
		}
	}

	if childStates, ok := data["states"].(map[string]any); ok {
		for cName, cVal := range childStates {
			if cMap, ok := cVal.(map[string]any); ok {
				s.States[cName] = parseStateDef(cName, cMap, ns)
			}
		}
	}

	if onMap, ok := data["on"].(map[string]any); ok {
		for evt, tVal := range onMap {
			var list []TransitionDefinition
			switch tv := tVal.(type) {
			case string:
				list = append(list, TransitionDefinition{Target: tv})
			case map[string]any:
				list = append(list, parseTransitionDef(tv, ns))
			case []any:
				for _, item := range tv {
					if str, ok := item.(string); ok {
						list = append(list, TransitionDefinition{Target: str})
					} else if m, ok := item.(map[string]any); ok {
						list = append(list, parseTransitionDef(m, ns))
					}
				}
			}
			s.On[evt] = list
		}
	}

	if onDone, ok := data["onDone"]; ok {
		var list []TransitionDefinition
		switch odv := onDone.(type) {
		case string:
			list = append(list, TransitionDefinition{Target: odv})
		case map[string]any:
			list = append(list, parseTransitionDef(odv, ns))
		case []any:
			for _, item := range odv {
				if str, ok := item.(string); ok {
					list = append(list, TransitionDefinition{Target: str})
				} else if m, ok := item.(map[string]any); ok {
					list = append(list, parseTransitionDef(m, ns))
				}
			}
		}
		s.OnDone = list
	}

	return s
}

func parseTransitionDef(data map[string]any, ns string) TransitionDefinition {
	var target string
	if t, ok := data["target"].(string); ok {
		target = t
	}

	var handler string
	if tr, ok := data["transition"].(string); ok {
		handler = qualify(tr, ns)
	} else if h, ok := data["handler"].(string); ok {
		handler = qualify(h, ns)
	}

	policy := parsePartialPolicy(data, ns)

	return TransitionDefinition{
		Target:  target,
		Handler: handler,
		Policy:  policy,
	}
}

func parsePartialPolicy(data map[string]any, ns string) *PartialTransitionPolicy {
	var maxAttempts *int
	var backoffMs *int
	var backoffFactor *float64
	var maxBackoffMs *int
	var backoff *string
	var jitter *bool
	var retryDefined bool

	if rData, ok := data["retry"].(map[string]any); ok {
		retryDefined = true
		if ma, ok := rData["maxAttempts"].(float64); ok {
			v := int(ma)
			maxAttempts = &v
		}
		if bm, ok := rData["backoffMs"].(float64); ok {
			v := int(bm)
			backoffMs = &v
		}
		if bf, ok := rData["backoffFactor"].(float64); ok {
			backoffFactor = &bf
		}
		if mm, ok := rData["maxBackoffMs"].(float64); ok {
			v := int(mm)
			maxBackoffMs = &v
		}
		if bo, ok := rData["backoff"]; ok {
			if s, ok := bo.(string); ok {
				backoff = &s
			} else if bMap, ok := bo.(map[string]any); ok {
				if st, ok := bMap["strategy"].(string); ok {
					backoff = &st
				}
				if idm, ok := bMap["initialDelayMs"].(float64); ok {
					v := int(idm)
					backoffMs = &v
				}
				if mdm, ok := bMap["maxDelayMs"].(float64); ok {
					v := int(mdm)
					maxBackoffMs = &v
				}
				if mul, ok := bMap["multiplier"].(float64); ok {
					backoffFactor = &mul
				}
			}
		}
		if j, ok := rData["jitter"].(bool); ok {
			jitter = &j
		}
	} else if ma, ok := data["retry"].(float64); ok {
		retryDefined = true
		v := int(ma)
		maxAttempts = &v
	}

	var cbEnabled *bool
	var cbFailure *int
	var cbRecovery *int
	var cbSuccess *int
	var cbDefined bool

	if cb, ok := data["circuitBreaker"].(map[string]any); ok {
		cbDefined = true
		if en, ok := cb["enabled"].(bool); ok {
			cbEnabled = &en
		}
		if ft, ok := cb["failureThreshold"].(float64); ok {
			v := int(ft)
			cbFailure = &v
		}
		if rt, ok := cb["recoveryTimeoutMs"].(float64); ok {
			v := int(rt)
			cbRecovery = &v
		} else if od, ok := cb["openDurationMs"].(float64); ok {
			v := int(od)
			cbRecovery = &v
		}
		if st, ok := cb["halfOpenSuccessThreshold"].(float64); ok {
			v := int(st)
			cbSuccess = &v
		} else if mc, ok := cb["halfOpenMaxCalls"].(float64); ok {
			v := int(mc)
			cbSuccess = &v
		}
	}

	var onFailTarget *string
	var onFailComp *bool
	var onFailDefined bool

	if of, ok := data["onFail"].(map[string]any); ok {
		onFailDefined = true
		if t, ok := of["target"].(string); ok {
			onFailTarget = &t
		}
		if c, ok := of["compensate"].(bool); ok {
			onFailComp = &c
		}
	}

	var compWith *string
	if cw, ok := data["compensateWith"].(string); ok {
		s := qualify(cw, ns)
		compWith = &s
	} else if c, ok := data["compensate"].(string); ok {
		s := qualify(c, ns)
		compWith = &s
	}

	var benchEnabled *bool
	var benchWarn *int

	if b, ok := data["benchmark"].(map[string]any); ok {
		if en, ok := b["enabled"].(bool); ok {
			benchEnabled = &en
		}
		if wt, ok := b["warnThresholdMs"].(float64); ok {
			v := int(wt)
			benchWarn = &v
		}
	}

	return &PartialTransitionPolicy{
		RetryMaxAttempts:   maxAttempts,
		RetryBackoffMs:     backoffMs,
		RetryBackoffFactor: backoffFactor,
		RetryMaxBackoffMs:  maxBackoffMs,
		RetryBackoff:       backoff,
		RetryJitter:        jitter,
		RetryDefined:       retryDefined,

		CbEnabled:           cbEnabled,
		CbFailureThreshold:  cbFailure,
		CbRecoveryTimeoutMs: cbRecovery,
		CbHalfOpenSuccess:   cbSuccess,
		CbDefined:           cbDefined,

		OnFailTarget:     onFailTarget,
		OnFailCompensate: onFailComp,
		OnFailDefined:    onFailDefined,

		CompensateWith: compWith,

		BenchmarkEnabled: benchEnabled,
		BenchmarkWarnMs:  benchWarn,
	}
}

func validateMachineAst(m *MachineDefinition) error {
	if strings.EqualFold(m.Type, "parallel") {
		return nil
	}

	if m.Initial == "" {
		return ValidationError{Message: fmt.Sprintf("Machine '%s' missing required root initial state", m.Id)}
	}

	if _, ok := m.States[m.Initial]; !ok {
		return ValidationError{Message: fmt.Sprintf("Machine '%s' initial state '%s' does not exist in states", m.Id, m.Initial)}
	}

	allStates := make(map[string]bool)
	collectAllStateNames(m.States, "", allStates)

	return validateHierarchy(m.States, allStates, m.Id)
}

func collectAllStateNames(states map[string]*StateDefinition, prefix string, set map[string]bool) {
	for name, s := range states {
		path := name
		if prefix != "" {
			path = prefix + "." + name
		}
		set[path] = true
		set[name] = true
		if len(s.States) > 0 {
			collectAllStateNames(s.States, path, set)
		}
	}
}

func validateHierarchy(states map[string]*StateDefinition, allStates map[string]bool, machineId string) error {
	for _, s := range states {
		if s.IsCompound() && len(s.States) > 0 {
			if s.Initial == "" {
				return ValidationError{Message: fmt.Sprintf("Compound state '%s' must define initial child state", s.Id)}
			}
			if _, ok := s.States[s.Initial]; !ok {
				return ValidationError{Message: fmt.Sprintf("Compound state '%s' initial state '%s' not found", s.Id, s.Initial)}
			}
		}

		for _, list := range s.On {
			for _, t := range list {
				if t.Target != "" && !allStates[t.Target] {
					return ValidationError{Message: fmt.Sprintf("Transition target '%s' from state '%s' does not exist in machine '%s'", t.Target, s.Id, machineId)}
				}
			}
		}

		if len(s.States) > 0 {
			if err := validateHierarchy(s.States, allStates, machineId); err != nil {
				return err
			}
		}
	}
	return nil
}

