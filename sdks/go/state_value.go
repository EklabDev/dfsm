package dfsm

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// StateValue represents a state in DFSM: either an atomic string state or
// a compound/parallel map mapping state/region names to child StateValues.
type StateValue struct {
	IsCompound bool
	Atomic     string
	Compound   map[string]StateValue
}

// Leaf creates an atomic StateValue.
func Leaf(state string) StateValue {
	return StateValue{
		IsCompound: false,
		Atomic:     state,
	}
}

// Compound creates a compound/parallel StateValue.
func CompoundState(m map[string]StateValue) StateValue {
	cp := make(map[string]StateValue, len(m))
	for k, v := range m {
		cp[k] = v
	}
	return StateValue{
		IsCompound: true,
		Compound:   cp,
	}
}

// SingleNested creates a compound StateValue with a single child state.
func SingleNested(parent string, child StateValue) StateValue {
	return StateValue{
		IsCompound: true,
		Compound:   map[string]StateValue{parent: child},
	}
}

// FromRaw converts an arbitrary interface (string, map[string]any, etc.) into StateValue.
func FromRaw(val any) StateValue {
	if val == nil {
		return Leaf("idle")
	}
	switch v := val.(type) {
	case StateValue:
		return v
	case string:
		return Leaf(v)
	case map[string]any:
		res := make(map[string]StateValue, len(v))
		for k, child := range v {
			res[k] = FromRaw(child)
		}
		return CompoundState(res)
	case map[string]StateValue:
		return CompoundState(v)
	default:
		return Leaf(fmt.Sprintf("%v", v))
	}
}

// Matches checks equality between two StateValues.
func (sv StateValue) Matches(other StateValue) bool {
	if !sv.IsCompound && !other.IsCompound {
		return sv.Atomic == other.Atomic
	}
	if sv.IsCompound && other.IsCompound {
		if len(sv.Compound) != len(other.Compound) {
			return false
		}
		for k, v := range sv.Compound {
			otherV, ok := other.Compound[k]
			if !ok || !v.Matches(otherV) {
				return false
			}
		}
		return true
	}
	return false
}

// String returns human-readable representation.
func (sv StateValue) String() string {
	if !sv.IsCompound {
		return sv.Atomic
	}
	bytes, _ := json.Marshal(sv)
	return string(bytes)
}

// MarshalJSON serializes StateValue as atomic string or JSON object.
func (sv StateValue) MarshalJSON() ([]byte, error) {
	if !sv.IsCompound {
		return json.Marshal(sv.Atomic)
	}
	return json.Marshal(sv.Compound)
}

// UnmarshalJSON deserializes JSON string or JSON object into StateValue.
func (sv *StateValue) UnmarshalJSON(data []byte) error {
	var s string
	if err := json.Unmarshal(data, &s); err == nil {
		sv.IsCompound = false
		sv.Atomic = s
		sv.Compound = nil
		return nil
	}

	var m map[string]json.RawMessage
	if err := json.Unmarshal(data, &m); err != nil {
		return err
	}

	sv.IsCompound = true
	sv.Atomic = ""
	sv.Compound = make(map[string]StateValue, len(m))
	for k, raw := range m {
		var child StateValue
		if err := child.UnmarshalJSON(raw); err != nil {
			return err
		}
		sv.Compound[k] = child
	}
	return nil
}

// HashKey returns a stable deterministic string for map keys.
func (sv StateValue) HashKey() string {
	if !sv.IsCompound {
		return sv.Atomic
	}
	keys := make([]string, 0, len(sv.Compound))
	for k := range sv.Compound {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var parts []string
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s:%s", k, sv.Compound[k].HashKey()))
	}
	return "{" + strings.Join(parts, ",") + "}"
}

