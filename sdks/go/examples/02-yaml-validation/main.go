package main

import (
	"context"
	"fmt"

	"github.com/eklabdev/dfsm/sdks/go"
)

type AccountContext struct {
	AccountId string `json:"accountId"`
	Email     string `json:"email"`
	Balance   int    `json:"balance"`
}

type DepositInput struct {
	Amount int    `json:"amount" validate:"required,min=1"`
	Email  string `json:"email" validate:"required,email"`
}

func main() {
	yamlDef := `
dfsm: "1.0"
id: "account-verification"
version: "1.0.0"
initial: "unverified"
states:
  unverified:
    on:
      DEPOSIT:
        target: "active"
        transition: "handleDeposit"
  active:
    on:
      FREEZE: "frozen"
  frozen:
    type: "final"
`

	machine, err := dfsm.ParseYamlMachine(yamlDef)
	if err != nil {
		panic(err)
	}

	reg := dfsm.NewFSMRegistry()
	reg.RegisterTransition("handleDeposit", func(ctx context.Context, req dfsm.TransitionRequest[AccountContext, DepositInput]) (dfsm.TransitionOutput[AccountContext, any], error) {
		req.Data.Email = req.Input.Email
		req.Data.Balance += req.Input.Amount
		fmt.Printf(">> Handled Deposit: Added $%d for %s (New Balance: $%d)\n", req.Input.Amount, req.Input.Email, req.Data.Balance)
		return dfsm.OutputWithContext[AccountContext, any](req.Data), nil
	}, nil)

	actor := dfsm.NewDfsmActor[AccountContext](machine, reg)
	ctx := context.Background()

	fmt.Println("=== DFSM Go Example 02: Input & Schema Validation ===")

	// 1. Invalid input: amount < 1
	_, err = actor.Transition(ctx, "acc-1", "DEPOSIT", DepositInput{Amount: 0, Email: "valid@eklab.dev"})
	if err != nil {
		fmt.Printf("[Expected Error 1]: %v\n", err)
	}

	// 2. Invalid input: bad email
	_, err = actor.Transition(ctx, "acc-1", "DEPOSIT", DepositInput{Amount: 50, Email: "invalid-email"})
	if err != nil {
		fmt.Printf("[Expected Error 2]: %v\n", err)
	}

	// 3. Valid input
	res, err := actor.Transition(ctx, "acc-1", "DEPOSIT", DepositInput{Amount: 100, Email: "owner@eklab.dev"})
	if err != nil {
		panic(err)
	}
	fmt.Printf("[Success]: Transitioned to %s\n", res.CurrentState)

	// 4. Schema validation error with invalid YAML
	badYaml := `
dfsm: "1.0"
id: "missing-states"
initial: "start"
`
	_, schemaErr := dfsm.ParseYamlMachine(badYaml)
	if schemaErr != nil {
		fmt.Printf("[Expected Schema Error]: %v\n", schemaErr)
	}
}

