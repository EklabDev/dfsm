package main

import (
	"context"
	"fmt"
	"time"

	"github.com/eklabdev/dfsm/sdks/go"
)

type WorkerContext struct {
	TaskId string `json:"taskId"`
}

func main() {
	yamlDef := `
dfsm: "1.0"
id: "worker-job"
version: "1.0.0"
initial: "queued"
states:
  queued:
    on:
      DISPATCH: "processing"
  processing:
    on:
      COMPLETE: "done"
      FAIL: "failed"
  done:
    type: "final"
  failed:
    type: "final"
`

	machine, err := dfsm.ParseYamlMachine(yamlDef)
	if err != nil {
		panic(err)
	}

	reg := dfsm.NewFSMRegistry()
	actor := dfsm.NewDfsmActor[WorkerContext](machine, reg)
	ctx := context.Background()

	fmt.Println("=== DFSM Go Example 05: Multi-Actor Ops & Sweep ===")

	// 1. Create a set of concurrent actors
	_, _ = actor.Transition(ctx, "job-1", "DISPATCH", nil)
	_, _ = actor.Transition(ctx, "job-1", "COMPLETE", nil) // completed

	_, _ = actor.Transition(ctx, "job-2", "DISPATCH", nil) // in processing (in-flight)

	_, _ = actor.Transition(ctx, "job-3", "DISPATCH", nil)
	_, _ = actor.Transition(ctx, "job-3", "FAIL", nil) // failed

	// Simulate an older stuck job
	now := time.Now().UnixMilli()
	_ = reg.Store.CreateTransaction(ctx, &dfsm.TransactionRecord{
		TransactionId: "job-stuck-orphan",
		MachineId:     "worker-job",
		CurrentState:  dfsm.Leaf("processing"),
		Status:        dfsm.StatusInFlight,
		ContextJson:   "{}",
		Version:       1,
		CreatedAt:     now - 3600000,
		UpdatedAt:     now - 3600000, // 1 hour ago
	})

	// 2. Query Status Breakdown
	breakdown, err := actor.GetStatusBreakdown(ctx)
	if err != nil {
		panic(err)
	}
	fmt.Printf("[Status Breakdown]: InFlight=%d, Completed=%d, Failed=%d\n",
		breakdown.InFlight, breakdown.Completed, breakdown.Failed)

	// 3. Query InFlightSummary
	summary, err := actor.GetInFlightSummary(ctx)
	if err != nil {
		panic(err)
	}
	fmt.Printf("[InFlight Summary]: Total In-Flight=%d | Non-Terminal Count=%d | Terminal States=%v\n",
		summary.TotalInFlight, summary.NonTerminalCount, summary.TerminalStates)

	// 4. Force Cleanup of stuck jobs (> 30 mins old)
	olderThan30m := int64(1800000)
	cleanResult, err := actor.ForceCleanUp(ctx, dfsm.ForceCleanUpOptions{
		OlderThanMs: &olderThan30m,
		StuckOnly:   true,
		Action:      dfsm.ActionMarkFail,
	})
	if err != nil {
		panic(err)
	}
	fmt.Printf("[Ops Cleanup]: Processed %d stuck job(s): %v marked as FAILED\n",
		cleanResult.ProcessedCount, cleanResult.AffectedTransactionIds)

	// 5. Query updated breakdown
	updatedBreakdown, _ := actor.GetStatusBreakdown(ctx)
	fmt.Printf("[Updated Breakdown]: InFlight=%d, Completed=%d, Failed=%d\n",
		updatedBreakdown.InFlight, updatedBreakdown.Completed, updatedBreakdown.Failed)
}

