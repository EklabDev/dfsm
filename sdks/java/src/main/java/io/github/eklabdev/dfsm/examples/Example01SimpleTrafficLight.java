package io.github.eklabdev.dfsm.examples;

import io.github.eklabdev.dfsm.StateValue;
import io.github.eklabdev.dfsm.TransactionStatus;
import io.github.eklabdev.dfsm.TransitionExecutionResult;
import io.github.eklabdev.dfsm.TransitionOutput;
import io.github.eklabdev.dfsm.annotation.TransitionDecoratorBuilder;
import io.github.eklabdev.dfsm.definition.MachineBuilder;
import io.github.eklabdev.dfsm.runtime.DfsmActor;
import io.github.eklabdev.dfsm.runtime.FSMRegistry;
import io.github.eklabdev.dfsm.runtime.MachineHandlerBindings;

import java.util.ArrayList;
import java.util.List;

/**
 * Progressive Example 01 (Simple):
 * Programmatic {@link MachineBuilder} traffic light with standalone atomic &amp; final states,
 * functional {@link TransitionDecoratorBuilder}, typed output, and post-commit {@code entry}/{@code exit} effects.
 */
public final class Example01SimpleTrafficLight {

    public record TrafficContext(int cycles, String lastOperator) {}

    public record AdvanceInput(String operator) {}

    public record SignalStepResult(String fromSignal, int totalCycles) {}

    public record DemoSummary(
            String transactionId,
            StateValue finalState,
            TransactionStatus finalStatus,
            TrafficContext finalContext,
            SignalStepResult lastOutput,
            List<String> effectLog
    ) {}

    private Example01SimpleTrafficLight() {}

    public static DemoSummary runDemo() {
        List<String> effectLog = new ArrayList<>();
        FSMRegistry registry = new FSMRegistry();

        var recordAdvance = TransitionDecoratorBuilder
                .<TrafficContext, AdvanceInput, SignalStepResult>of(req -> {
                    int nextCycles = req.data().cycles() + 1;
                    String op = req.input() != null ? req.input().operator() : "auto";
                    return TransitionOutput.of(
                            new TrafficContext(nextCycles, op),
                            new SignalStepResult(req.currentState().asLeaf(), nextCycles)
                    );
                })
                .named("recordAdvance")
                .inputType(AdvanceInput.class)
                .benchmark(true)
                .build();

        MachineBuilder<TrafficContext> builder = MachineBuilder.<TrafficContext>create("traffic-light-simple")
                .version("1.0.0")
                .namespace("traffic")
                .initial("red")
                .state("red", s -> s
                        .entry("onEnterRed")
                        .exit("onExitRed")
                        .on("NEXT", "green", "recordAdvance")
                        .on("DECOMMISSION", "maintenance"))
                .state("green", s -> s
                        .entry("onEnterGreen")
                        .on("NEXT", "yellow", "recordAdvance"))
                .state("yellow", s -> s
                        .on("NEXT", "red", "recordAdvance"))
                .finalState("maintenance", s -> s.entry("onMaintenance"));

        registry.registerBuilder(builder, MachineHandlerBindings.builder()
                .transition("recordAdvance", recordAdvance)
                .effect("onEnterRed", req -> effectLog.add("enter:red"))
                .effect("onExitRed", req -> effectLog.add("exit:red"))
                .effect("onEnterGreen", req -> effectLog.add("enter:green"))
                .effect("onMaintenance", req -> effectLog.add("enter:maintenance"))
                .build());

        DfsmActor<TrafficContext> actor = registry.createActor("traffic-light-simple", TrafficContext.class);

        String txId = actor.startTransaction(new TrafficContext(0, "init"));
        actor.transition(txId, "NEXT", new AdvanceInput("ctrl-1"));   // red -> green
        actor.transition(txId, "NEXT", new AdvanceInput("ctrl-2"));   // green -> yellow
        TransitionExecutionResult<TrafficContext, SignalStepResult> backToRed =
                actor.transition(txId, "NEXT", new AdvanceInput("ctrl-3")); // yellow -> red
        TransitionExecutionResult<TrafficContext, Void> ended =
                actor.transition(txId, "DECOMMISSION", null);         // red -> maintenance (final)

        registry.shutdown();
        return new DemoSummary(
                txId,
                ended.currentState(),
                ended.status(),
                ended.context(),
                backToRed.value(),
                effectLog
        );
    }

    public static void main(String[] args) {
        DemoSummary summary = runDemo();
        System.out.println("=== Example 01: Simple Traffic Light ===");
        System.out.println("Transaction ID : " + summary.transactionId());
        System.out.println("Final State    : " + summary.finalState());
        System.out.println("Final Status   : " + summary.finalStatus());
        System.out.println("Final Context  : " + summary.finalContext());
        System.out.println("Last Output    : " + summary.lastOutput());
        System.out.println("Effect Log     : " + summary.effectLog());
    }
}
