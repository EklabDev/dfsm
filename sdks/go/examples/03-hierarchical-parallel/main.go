package main

import (
	"context"
	"fmt"

	"github.com/eklabdev/dfsm/sdks/go"
)

type FulfillmentContext struct {
	TrackingNumber string `json:"trackingNumber"`
	InvoiceId      string `json:"invoiceId"`
}

func main() {
	yamlDef := `
dfsm: "1.0"
id: "fulfillment-process"
version: "1.0.0"
initial: "fulfilling"
states:
  fulfilling:
    type: "parallel"
    onDone: "completed"
    states:
      shipping:
        initial: "pending"
        states:
          pending:
            on:
              SHIP: "dispatched"
          dispatched:
            type: "final"
      billing:
        initial: "unpaid"
        states:
          unpaid:
            on:
              PAY: "settled"
          settled:
            type: "final"
  completed:
    type: "final"
`

	machine, err := dfsm.ParseYamlMachine(yamlDef)
	if err != nil {
		panic(err)
	}

	reg := dfsm.NewFSMRegistry()
	actor := dfsm.NewDfsmActor[FulfillmentContext](machine, reg)
	ctx := context.Background()
	txId := "order-fulfillment-1"

	fmt.Println("=== DFSM Go Example 03: Parallel Regions & onDone ===")

	// 1. Initial parallel state
	state0, err := actor.GetState(ctx, txId)
	if err == nil {
		fmt.Printf("Initial: %s\n", state0.CurrentState)
	}

	// 2. Dispatch shipping region
	res1, err := actor.Transition(ctx, txId, "SHIP", nil)
	if err != nil {
		panic(err)
	}
	fmt.Printf("[1] SHIP -> %s (Status: %s)\n", res1.CurrentState, res1.Status)

	// 3. Pay billing region -> triggers onDone -> completed!
	res2, err := actor.Transition(ctx, txId, "PAY", nil)
	if err != nil {
		panic(err)
	}
	fmt.Printf("[2] PAY -> %s (Status: %s - onDone triggered!)\n", res2.CurrentState, res2.Status)

	finalState, err := actor.GetState(ctx, txId)
	if err != nil {
		panic(err)
	}
	fmt.Printf("Final Transaction State: %s | Status: %s\n", finalState.CurrentState, finalState.Status)
}

