package dfsm

import (
	"fmt"
)

type BenchmarkEvent struct {
	TransactionId string
	MachineId     string
	EventName     string
	HandlerName   string
	Attempts      int
	Outcome       string
	DurationMs    int64
	PreviousState StateValue
	CurrentState  StateValue
	ErrorMessage  string
}

type BenchmarkLogEngine interface {
	Record(evt BenchmarkEvent)
	Log(msg string)
}

type ConsoleBenchmarkLogEngine struct{}

func (ConsoleBenchmarkLogEngine) Record(evt BenchmarkEvent) {
	line := fmt.Sprintf("[DFSM-STEP] tx=%s | event=%s | handler=%s | attempts=%d | outcome=%s (%dms) | %s -> %s",
		evt.TransactionId, evt.EventName, evt.HandlerName, evt.Attempts, evt.Outcome, evt.DurationMs, evt.PreviousState, evt.CurrentState)
	if evt.ErrorMessage != "" {
		line += fmt.Sprintf(" | error=\"%s\"", evt.ErrorMessage)
	}
	fmt.Println(line)
}

func (ConsoleBenchmarkLogEngine) Log(msg string) {
	fmt.Println(msg)
}

type NoOpBenchmarkLogEngine struct{}

func (NoOpBenchmarkLogEngine) Record(evt BenchmarkEvent) {}
func (NoOpBenchmarkLogEngine) Log(msg string)           {}

