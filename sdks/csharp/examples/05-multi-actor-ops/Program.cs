using System;
using System.Collections.Generic;
using System.Threading.Tasks;
using EKLabDev.Dfsm;
using EKLabDev.Dfsm.Attributes;
using EKLabDev.Dfsm.Definition;
using EKLabDev.Dfsm.Runtime;

namespace EKLabDev.Dfsm.Examples;

public class Program
{
    public class LoanApplicationContext
    {
        public string ApplicantId { get; set; } = string.Empty;
        public decimal RequestedAmount { get; set; }
        public int CreditScore { get; set; }
        public string Tier { get; set; } = string.Empty;
    }

    public class LoanUnderwritingService
    {
        [DfsmTransition("submitApplication")]
        public TransitionOutput<LoanApplicationContext, string> SubmitApplication(
            TransitionRequest<LoanApplicationContext, LoanApplicationContext> req)
        {
            var ctx = req.Input;
            Console.WriteLine($"[Underwriter] Received application: {ctx.ApplicantId}, Amount: ${ctx.RequestedAmount}, Score: {ctx.CreditScore}");
            return TransitionOutput<LoanApplicationContext, string>.Of(ctx, "APPLICATION_SUBMITTED");
        }

        // Conditional effect router acting like an if/else router
        [DfsmEffect("evaluateRiskTier")]
        public async Task EvaluateRiskTier(EffectRequest<LoanApplicationContext> req)
        {
            var ctx = req.Context;
            Console.WriteLine($"[Effect Router] Evaluating tier for score {ctx?.CreditScore}...");

            if (ctx != null && ctx.CreditScore >= 750)
            {
                Console.WriteLine("[Effect Router] High score -> Auto-approving loan!");
                await req.Actor.TransitionAsync(req.TransactionId, "AUTO_APPROVE");
            }
            else
            {
                Console.WriteLine("[Effect Router] Moderate score -> Routing to manual underwriter review.");
                await req.Actor.TransitionAsync(req.TransactionId, "ROUTE_MANUAL");
            }
        }

        [DfsmHook(HookType.OnStart)]
        public void OnStart(ActorLifecycleEvents.OnStartEvent e)
        {
            Console.WriteLine($"[DFSM-HOOK] onStart: tx={e.TransactionId}, state={e.InitialState}");
        }

        [DfsmHook(HookType.OnTerminal)]
        public void OnTerminal(ActorLifecycleEvents.OnTerminalEvent e)
        {
            Console.WriteLine($"[DFSM-HOOK] onTerminal: tx={e.TransactionId}, finalState={e.FinalState}, status={e.Status}");
        }
    }

    public static async Task Main(string[] args)
    {
        Console.WriteLine("=== DFSM C# Example 05: Multi-Actor, Hooks, Effect Routers & Ops APIs ===");

        string yaml = @"
dfsm: '1.0'
id: loan-approval-machine
version: '1.0.0'
description: Loan underwriting with conditional effect auto-routing and full ops inspection
initial: intake

registry:
  namespace: 'loan'
  strict: true

states:
  intake:
    on:
      SUBMIT:
        target: underwrite
        transition: submitApplication

  underwrite:
    entry: [evaluateRiskTier]
    on:
      AUTO_APPROVE: approved
      ROUTE_MANUAL: review_queue

  review_queue:
    on:
      OFFICER_APPROVE: approved
      OFFICER_REJECT: rejected

  approved:
    type: final

  rejected:
    type: final
";

        var machine = YamlMachineParser.Parse(yaml);
        var registry = new FSMRegistry();
        registry.RegisterMachine(machine);
        registry.RegisterAnnotatedHandlers(new LoanUnderwritingService());

        var actor = registry.CreateActor<LoanApplicationContext>("loan-approval-machine");

        // 1. Transaction A: High credit score (780) -> auto-transitions into approved
        Console.WriteLine("\n--> Case A: Applicant with score 780:");
        string txA = "tx-loan-auto-01";
        await actor.TransitionAsync(txA, "SUBMIT", new LoanApplicationContext
        {
            ApplicantId = "USER-780",
            RequestedAmount = 25000,
            CreditScore = 780
        });

        var stateA = await actor.GetStateAsync(txA);
        Console.WriteLine($"Final State: {stateA.CurrentState}, Status: {stateA.Status}");

        // 2. Transaction B: Moderate credit score (650) -> stays in review_queue
        Console.WriteLine("\n--> Case B: Applicant with score 650:");
        string txB = "tx-loan-manual-02";
        await actor.TransitionAsync(txB, "SUBMIT", new LoanApplicationContext
        {
            ApplicantId = "USER-650",
            RequestedAmount = 45000,
            CreditScore = 650
        });

        var stateB = await actor.GetStateAsync(txB);
        Console.WriteLine($"Current State: {stateB.CurrentState}, Status: {stateB.Status}");

        // 3. Ops Introspection APIs
        Console.WriteLine("\n=== DFSM Operations Introspection APIs ===");
        var summary = await actor.GetInFlightSummaryAsync();
        Console.WriteLine($"Active Non-Terminal Instances: {summary.NonTerminalCount}");
        Console.WriteLine($"Active In-Flight Instances: {summary.TotalInFlight}");
        Console.WriteLine($"Terminal States: {string.Join(", ", summary.TerminalStates)}");
        Console.WriteLine($"Breakdown: Idle={summary.Breakdown.Idle}, Completed={summary.Breakdown.Completed}, Failed={summary.Breakdown.Failed}");

        // 4. Force Clean-Up Dry Run
        Console.WriteLine("\n--> Performing Administrative Force Clean-Up Dry Run:");
        var dryRun = await actor.ForceCleanUpAsync(new ForceCleanUpOptions(
            Action: ForceCleanUpAction.MARK_FAIL,
            DryRun: true
        ));
        Console.WriteLine($"DryRun Result: Matched={dryRun.MatchedCount}, Processed={dryRun.ProcessedCount}, Affected={string.Join(", ", dryRun.AffectedTransactionIds)}");

        Console.WriteLine("\nExample 05 completed successfully!");
    }
}

