using System;
using System.Collections.Generic;
using System.ComponentModel.DataAnnotations;
using System.Threading.Tasks;
using EKLabDev.Dfsm;
using EKLabDev.Dfsm.Attributes;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Policy;
using EKLabDev.Dfsm.Runtime;
using EKLabDev.Dfsm.Store;
using EKLabDev.Dfsm.Telemetry;
using EKLabDev.Dfsm.Validation;
using FluentAssertions;
using Xunit;

namespace EKLabDev.Dfsm.Tests;

public class DfsmUnitTests
{
    public class OrderContext
    {
        public string OrderId { get; set; } = string.Empty;
        public decimal Total { get; set; }
        public bool Paid { get; set; }
    }

    public class CreateOrderInput
    {
        [Required]
        [MinLength(3)]
        public string CustomerEmail { get; set; } = string.Empty;

        [Range(1, 10000)]
        public decimal Amount { get; set; }
    }

    [Fact]
    public void DataAnnotationsValidation_ThrowsOnInvalidInput()
    {
        var validator = DataAnnotationsSchemaValidator.Instance;
        var invalidInput = new CreateOrderInput { CustomerEmail = "a", Amount = -10 };

        Action act = () => validator.Validate(invalidInput, "CreateOrderInput");

        act.Should().Throw<ValidationException>()
            .WithMessage("*Validation failed*");
    }

    [Fact]
    public void PolicyMerger_CodeOverridesYamlWithoutMultiplyingRetries()
    {
        var codePolicy = new PartialTransitionPolicy(RetryMaxAttempts: 4, RetryExplicitlyDefined: true);
        var yamlPolicy = new PartialTransitionPolicy(
            RetryMaxAttempts: 3,
            CbFailureThreshold: 5,
            CbRecoveryTimeoutMs: 15000,
            CbExplicitlyDefined: true
        );
        var machineDefaults = new PartialTransitionPolicy(RetryMaxAttempts: 2);

        var merged = PolicyMerger.Merge(codePolicy, yamlPolicy, machineDefaults, PartialTransitionPolicy.Empty);

        merged.Retry.MaxAttempts.Should().Be(4); // Overridden from code, not multiplied!
        merged.CircuitBreaker.Should().NotBeNull();
        merged.CircuitBreaker!.FailureThreshold.Should().Be(5); // Inherited from YAML
        merged.CircuitBreaker.RecoveryTimeoutMs.Should().Be(15000);
    }

    [Fact]
    public void CircuitBreaker_TripsOpenAndBlocksUntilRecovery()
    {
        var clock = new VirtualClock(1000);
        var policy = new CircuitBreakerPolicy(FailureThreshold: 2, RecoveryTimeoutMs: 5000, HalfOpenSuccessThreshold: 1);
        var cb = new CircuitBreakerInstance(policy, clock);

        // Fail 1
        cb.BeforeExecution("testHandler");
        cb.OnFailure();

        // Fail 2 -> trips open!
        cb.BeforeExecution("testHandler");
        cb.OnFailure();

        // Should be OPEN now
        Action act = () => cb.BeforeExecution("testHandler");
        act.Should().Throw<CircuitOpenException>();

        // Advance clock past recovery timeout
        clock.Advance(5001);

        // Now HalfOpen -> allowed
        cb.BeforeExecution("testHandler");
        cb.OnSuccess(); // Should close!

        // Closed -> allowed
        cb.BeforeExecution("testHandler");
    }

    [Fact]
    public async Task FluentMachineBuilder_ExecutesLifecycleAndTerminalHooks()
    {
        var hookEvents = new List<string>();

        var machine = MachineBuilder<OrderContext>.Create("checkout-machine")
            .Initial("created")
            .State("created", s => s
                .On("SUBMIT", "paying", policyConfig: p => p.Retry(2))
            )
            .State("paying", s => s
                .On("PAY_SUCCESS", "completed")
                .On("PAY_FAIL", "error")
            )
            .State("completed", s => s.Type("final"))
            .Build();

        var registry = new FSMRegistry(
            store: new SqliteStateStore($"Data Source=dfsm_fluent_{Guid.NewGuid():N};Mode=Memory;Cache=Shared"),
            benchmarkEngine: NoOpBenchmarkLogEngine.Instance
        );

        registry.RegisterMachine(machine);
        registry.RegisterHook(HookType.OnStart, (ActorLifecycleEvents.OnStartEvent e) => hookEvents.Add("onStart"));
        registry.RegisterHook(HookType.BeforeTransition, (ActorLifecycleEvents.BeforeTransitionEvent e) => hookEvents.Add($"before:{e.EventName}"));
        registry.RegisterHook(HookType.AfterTransition, (ActorLifecycleEvents.AfterTransitionEvent e) => hookEvents.Add($"after:{e.EventName}"));
        registry.RegisterHook(HookType.OnComplete, (ActorLifecycleEvents.OnCompleteEvent e) => hookEvents.Add("onComplete"));
        registry.RegisterHook(HookType.OnTerminal, (ActorLifecycleEvents.OnTerminalEvent e) => hookEvents.Add("onTerminal"));

        var actor = registry.CreateActor<OrderContext>("checkout-machine");
        string txId = $"tx-{Guid.NewGuid():N}";

        var res1 = await actor.TransitionAsync(txId, "SUBMIT");
        res1.CurrentState.Should().Be(StateValue.Of("paying"));
        res1.Status.Should().Be(TransactionStatus.IDLE);

        var res2 = await actor.TransitionAsync(txId, "PAY_SUCCESS");
        res2.CurrentState.Should().Be(StateValue.Of("completed"));
        res2.Status.Should().Be(TransactionStatus.COMPLETED);

        hookEvents.Should().ContainInOrder("onStart", "before:SUBMIT", "after:SUBMIT", "before:PAY_SUCCESS", "after:PAY_SUCCESS", "onComplete", "onTerminal");
    }

    [Fact]
    public async Task ConditionalEffectRouting_ChainsTransitionsWithinLoopGuard()
    {
        var machine = MachineBuilder<OrderContext>.Create("order-router")
            .Initial("pending")
            .MaxEffectChainDepth(10)
            .State("pending", s => s
                .Entry("evaluateOrder")
                .On("ROUTE_VIP", "vip_processing")
                .On("ROUTE_STANDARD", "standard_processing")
            )
            .State("vip_processing", s => s.Type("final"))
            .State("standard_processing", s => s.Type("final"))
            .Build();

        var registry = new FSMRegistry(
            store: new SqliteStateStore($"Data Source=dfsm_effect_{Guid.NewGuid():N};Mode=Memory;Cache=Shared"),
            benchmarkEngine: NoOpBenchmarkLogEngine.Instance
        );
        registry.RegisterMachine(machine);

        registry.RegisterEffect("evaluateOrder", async (EffectRequest<OrderContext> req) =>
        {
            // Conditional routing based on context / input
            if (req.Context != null && req.Context.Total > 500)
            {
                await req.Actor.TransitionAsync(req.TransactionId, "ROUTE_VIP");
            }
            else
            {
                await req.Actor.TransitionAsync(req.TransactionId, "ROUTE_STANDARD");
            }
        });

        var actor = registry.CreateActor<OrderContext>("order-router");
        string txId = $"tx-vip-{Guid.NewGuid():N}";

        // Initialize record with total = 1000
        await registry.Store.CreateTransactionAsync(new TransactionRecord
        {
            TransactionId = txId,
            MachineId = "order-router",
            CurrentState = StateValue.Of("pending"),
            Status = TransactionStatus.IDLE,
            ContextJson = System.Text.Json.JsonSerializer.Serialize(new OrderContext { OrderId = txId, Total = 1000 })
        });

        // Run the effect
        await actor.RunEffectAsync(txId, "evaluateOrder");

        var state = await actor.GetStateAsync(txId);
        state.CurrentState.Should().Be(StateValue.Of("vip_processing"));
        state.Status.Should().Be(TransactionStatus.COMPLETED);
    }

    [Fact]
    public async Task OpsApis_InFlightSummaryAndForceCleanUpDryRun()
    {
        var machine = MachineBuilder<OrderContext>.Create("ops-machine")
            .Initial("idle")
            .State("idle", s => s.On("START", "working"))
            .State("working", s => s.On("FINISH", "done"))
            .State("done", s => s.Type("final"))
            .Build();

        var registry = new FSMRegistry(
            store: new SqliteStateStore($"Data Source=dfsm_ops_{Guid.NewGuid():N};Mode=Memory;Cache=Shared"),
            benchmarkEngine: NoOpBenchmarkLogEngine.Instance
        );
        registry.RegisterMachine(machine);
        var actor = registry.CreateActor<OrderContext>("ops-machine");

        // Create 2 transactions in 'working'
        await actor.TransitionAsync("tx-1", "START");
        await actor.TransitionAsync("tx-2", "START");

        var summary = await actor.GetInFlightSummaryAsync();
        summary.NonTerminalCount.Should().Be(2);
        summary.TerminalStates.Should().Contain("done");

        // Dry Run clean-up
        var dryRunResult = await actor.ForceCleanUpAsync(new ForceCleanUpOptions(
            Action: ForceCleanUpAction.MARK_FAIL,
            DryRun: true
        ));

        dryRunResult.DryRun.Should().BeTrue();
        dryRunResult.MatchedCount.Should().Be(2);
        dryRunResult.ProcessedCount.Should().Be(0);

        // Real clean-up
        var realResult = await actor.ForceCleanUpAsync(new ForceCleanUpOptions(
            Action: ForceCleanUpAction.MARK_FAIL,
            DryRun: false
        ));

        realResult.ProcessedCount.Should().Be(2);
        var st = await actor.GetStateAsync("tx-1");
        st.Status.Should().Be(TransactionStatus.FAILED);
        st.CurrentState.Should().Be(StateValue.Of("error"));
    }
}
