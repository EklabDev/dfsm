package dfsm_test

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/eklabdev/dfsm/sdks/go"
	"github.com/stretchr/testify/require"
)

func findConformanceDir(t *testing.T) string {
	wd, err := os.Getwd()
	require.NoError(t, err)

	dir := wd
	for {
		candidate := filepath.Join(dir, "spec", "conformance")
		if info, err := os.Stat(candidate); err == nil && info.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("Could not locate spec/conformance directory from %s", wd)
	return ""
}

type ConformanceSuite struct {
	Version   string                `json:"version"`
	Scenarios []ConformanceScenario `json:"scenarios"`
}

type ConformanceScenario struct {
	Id               string         `json:"id"`
	File             string         `json:"file"`
	MachineId        string         `json:"machineId"`
	Description      string         `json:"description"`
	ExpectedInitial  any            `json:"expectedInitialState"`
	Steps            []ScenarioStep `json:"steps"`
	CompensationLog  []string       `json:"expectedCompensationOrder"`
	Overrides        map[string]any `json:"decoratorOverrides"`
}

type ScenarioStep struct {
	Event          string `json:"event"`
	Input          any    `json:"input"`
	ExpectedState  any    `json:"expectedState"`
	ExpectedStatus string `json:"expectedStatus"`
}

func TestCanonicalConformanceSuite(t *testing.T) {
	confDir := findConformanceDir(t)
	suitePath := filepath.Join(confDir, "conformance-suite.json")
	suiteBytes, err := os.ReadFile(suitePath)
	require.NoError(t, err)

	var suite ConformanceSuite
	err = json.Unmarshal(suiteBytes, &suite)
	require.NoError(t, err)

	for _, sc := range suite.Scenarios {
		sc := sc
		t.Run(sc.Id+" - "+sc.Description, func(t *testing.T) {
			runScenario(t, confDir, sc)
		})
	}
}

func runScenario(t *testing.T, confDir string, sc ConformanceScenario) {
	ctx := context.Background()
	var compensationLog []string
	clock := dfsm.NewVirtualClock(1000)

	registry := dfsm.NewFSMRegistry(
		dfsm.WithStore(dfsm.NewMemoryStateStore()),
		dfsm.WithBenchmark(dfsm.NoOpBenchmarkLogEngine{}),
		dfsm.WithClock(clock),
	)

	// Register standard transitions
	for _, txName := range []string{
		"conformance.traffic.recordStep",
		"conformance.hierarchy.beginAuth",
		"conformance.hierarchy.captureFunds",
		"conformance.hierarchy.markCancelled",
		"conformance.parallel.initFulfillment",
		"conformance.parallel.recordPaid",
		"conformance.parallel.recordPacked",
		"conformance.saga.bookFlight",
		"conformance.saga.bookHotel",
	} {
		registry.RegisterTransition(txName, func(req dfsm.TransitionRequest[map[string]any, map[string]any]) dfsm.TransitionOutput[map[string]any, any] {
			merged := make(map[string]any)
			for k, v := range req.Data {
				merged[k] = v
			}
			for k, v := range req.Input {
				merged[k] = v
			}
			return dfsm.OutputWithContext[map[string]any, any](merged)
		}, nil)
	}

	// Register failure transitions
	for _, failTxName := range []string{
		"conformance.traffic.brokenBulb",
		"conformance.resilience.callPrimary",
		"conformance.resilience.alwaysFail",
		"conformance.saga.bookCar",
	} {
		name := failTxName
		fn := func(req dfsm.TransitionRequest[map[string]any, map[string]any]) (dfsm.TransitionOutput[map[string]any, any], error) {
			shouldFail := true
			if req.Input != nil {
				if f, ok := req.Input["fail"]; ok {
					if b, ok := f.(bool); ok && !b {
						shouldFail = false
					}
				}
			}
			if shouldFail {
				return dfsm.OutputEmpty[map[string]any, any](), fmt.Errorf("simulated failure in %s", name)
			}
			return dfsm.OutputEmpty[map[string]any, any](), nil
		}

		var p *dfsm.PartialTransitionPolicy
		if sc.Overrides != nil {
			if ov, ok := sc.Overrides[failTxName].(map[string]any); ok {
				if rData, ok := ov["retry"].(map[string]any); ok {
					if ma, ok := rData["maxAttempts"].(float64); ok {
						v := int(ma)
						p = &dfsm.PartialTransitionPolicy{
							RetryMaxAttempts: &v,
							RetryDefined:     true,
						}
					}
				}
			}
		}

		registry.RegisterTransition(failTxName, fn, p)
	}

	// Register compensations
	for _, compName := range []string{
		"conformance.saga.cancelFlight",
		"conformance.saga.cancelHotel",
		"conformance.saga.cancelCar",
	} {
		cn := compName
		registry.RegisterCompensate(cn, func(req dfsm.CompensationRequest[map[string]any]) {
			compensationLog = append(compensationLog, cn)
		})
	}

	// Register effects
	for _, effName := range []string{
		"conformance.traffic.onEnterRed",
		"conformance.traffic.onExitRed",
		"conformance.hierarchy.enterActive",
		"conformance.hierarchy.exitActive",
		"conformance.hierarchy.enterIdle",
		"conformance.hierarchy.exitIdle",
		"conformance.hierarchy.enterAuthorizing",
		"conformance.hierarchy.exitAuthorizing",
		"conformance.parallel.notifyShipped",
		"conformance.resilience.alertError",
	} {
		registry.RegisterEffect(effName, func(req dfsm.EffectRequest[map[string]any]) {})
	}

	yamlPath := filepath.Join(confDir, sc.File)
	yamlBytes, err := os.ReadFile(yamlPath)
	require.NoError(t, err)

	machine, err := dfsm.ParseYamlMachine(string(yamlBytes))
	require.NoError(t, err)
	registry.RegisterMachine(machine)

	actor := dfsm.NewDfsmActor[map[string]any](machine, registry)
	txId := fmt.Sprintf("tx-%s", sc.Id)

	for _, step := range sc.Steps {
		var inputMap map[string]any
		if step.Input != nil {
			b, _ := json.Marshal(step.Input)
			_ = json.Unmarshal(b, &inputMap)
		}

		res, err := actor.Transition(ctx, txId, step.Event, inputMap)
		require.NoError(t, err)

		expectedState := dfsm.FromRaw(step.ExpectedState)
		expectedStatus := dfsm.TransactionStatus(step.ExpectedStatus)

		require.True(t, res.CurrentState.Matches(expectedState),
			"Scenario %s step %s: expected state %s, got %s", sc.Id, step.Event, expectedState, res.CurrentState)
		require.Equal(t, expectedStatus, res.Status,
			"Scenario %s step %s: expected status %s, got %s", sc.Id, step.Event, expectedStatus, res.Status)
	}

	if len(sc.CompensationLog) > 0 {
		require.Equal(t, sc.CompensationLog, compensationLog,
			"Scenario %s compensation order mismatch", sc.Id)
	}
}

