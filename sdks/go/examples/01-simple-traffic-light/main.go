package main

import (
	"context"
	"fmt"

	"github.com/eklabdev/dfsm/sdks/go"
)

type TrafficContext struct {
	CycleCount int `json:"cycleCount"`
}

func main() {
	yamlDef := `
dfsm: "1.0"
id: "traffic-light"
version: "1.0.0"
description: "Simple traffic light state machine in Go"
initial: "red"
states:
  red:
    on:
      TIMER: "green"
  green:
    on:
      TIMER: "yellow"
  yellow:
    on:
      TIMER: "red"
      OFF: "off"
  off:
    type: "final"
`

	machine, err := dfsm.ParseYamlMachine(yamlDef)
	if err != nil {
		panic(err)
	}

	reg := dfsm.NewFSMRegistry()
	actor := dfsm.NewDfsmActor[TrafficContext](machine, reg)
	ctx := context.Background()
	txId := "traffic-light-1"

	fmt.Println("=== DFSM Go Example 01: Simple Traffic Light ===")

	// Initial transition
	res1, err := actor.Transition(ctx, txId, "TIMER", nil)
	if err != nil {
		panic(err)
	}
	fmt.Printf("[1] red -> %s (Event: %s)\n", res1.CurrentState, res1.EventName)

	res2, err := actor.Transition(ctx, txId, "TIMER", nil)
	if err != nil {
		panic(err)
	}
	fmt.Printf("[2] green -> %s (Event: %s)\n", res2.CurrentState, res2.EventName)

	res3, err := actor.Transition(ctx, txId, "OFF", nil)
	if err != nil {
		panic(err)
	}
	fmt.Printf("[3] yellow -> %s (Final State!)\n", res3.CurrentState)

	state, err := actor.GetState(ctx, txId)
	if err != nil {
		panic(err)
	}
	fmt.Printf("Final Status: %s | State: %s\n", state.Status, state.CurrentState)
}

