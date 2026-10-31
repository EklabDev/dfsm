import {
  CompensateWith,
  DfsmCompensate,
  DfsmEffect,
  DfsmTransition,
  FSMRegistry,
  InMemoryBenchmarkLogger,
  OnFail,
  Retry,
  type CompensationRequest,
  type EffectRequest,
  type TransitionOutput,
  type TransitionRequest,
} from "../src/index.js";

export interface SagaBookingContext {
  flightBooked: boolean;
  hotelBooked: boolean;
  paymentCharged: boolean;
  compensationTrail: string[];
}

/**
 * Notice how YAML defines:
 *   - chargeCustomer: retry.maxAttempts = 3, circuitBreaker.enabled = true (threshold 2)
 * While the TypeScript Decorator on `chargeCustomer` defines:
 *   - @Retry(4) and @OnFail({ compensate: true, target: "manual_escalation" })
 *
 * DFSM's Policy Normalizer deduplicates and merges them into:
 *   - retry.maxAttempts = 4 (Decorator wins over YAML's 3 — NO duplicate retry loop!)
 *   - circuitBreaker.enabled = true (preserved from YAML!)
 *   - onFail = { compensate: true, target: "manual_escalation" } (from Decorator!)
 */
const SAGA_POLICY_MERGE_YAML = `
dfsm: "1.0"
id: travel-saga-policy-merge
version: "1.0.0"
initial: reserve_flight

registry:
  namespace: "travel.saga"
  strict: true

defaults:
  retry:
    maxAttempts: 1
    backoff:
      strategy: fixed
      initialDelayMs: 1
      maxDelayMs: 5
      multiplier: 1
  benchmark:
    enabled: true

states:
  reserve_flight:
    on:
      BOOK_FLIGHT:
        target: reserve_hotel
        transition: bookFlight
        compensate: cancelFlight

  reserve_hotel:
    on:
      BOOK_HOTEL:
        target: charge_payment
        transition: bookHotel
        compensate: cancelHotel

  charge_payment:
    on:
      PAY:
        target: itinerary_ready
        transition: chargeCustomer
        retry:
          maxAttempts: 3
        circuitBreaker:
          enabled: true
          failureThreshold: 2
          slidingWindowSize: 5
          openDurationMs: 60000
          halfOpenMaxCalls: 1

  manual_escalation:
    on:
      ESCALATE_TO_ERROR: error

  itinerary_ready:
    type: final

  # Custom overridden error state allowing operator RESET
  error:
    entry: [notifyOpsTeam]
    on:
      RESET_SAGA: reserve_flight
`;

class TravelSagaService {
  public chargeAttempts = 0;
  public opsAlerts: string[] = [];

  @DfsmTransition("bookFlight")
  @CompensateWith("cancelFlight")
  bookFlight(
    req: TransitionRequest<SagaBookingContext>
  ): TransitionOutput<SagaBookingContext, string> {
    return {
      context: { ...req.context.data, flightBooked: true },
      value: "FLIGHT-OK",
    };
  }

  @DfsmCompensate("cancelFlight")
  cancelFlight(req: CompensationRequest<SagaBookingContext>): SagaBookingContext {
    return {
      ...req.currentContext,
      flightBooked: false,
      compensationTrail: [...req.currentContext.compensationTrail, "cancelFlight"],
    };
  }

  @DfsmTransition("bookHotel")
  @CompensateWith("cancelHotel")
  bookHotel(
    req: TransitionRequest<SagaBookingContext>
  ): TransitionOutput<SagaBookingContext, string> {
    return {
      context: { ...req.context.data, hotelBooked: true },
      value: "HOTEL-OK",
    };
  }

  @DfsmCompensate("cancelHotel")
  cancelHotel(req: CompensationRequest<SagaBookingContext>): SagaBookingContext {
    return {
      ...req.currentContext,
      hotelBooked: false,
      compensationTrail: [...req.currentContext.compensationTrail, "cancelHotel"],
    };
  }

  @DfsmTransition("chargeCustomer")
  @Retry(4)
  @OnFail({ compensate: true, target: "manual_escalation" })
  chargeCustomer(): TransitionOutput<SagaBookingContext> {
    this.chargeAttempts++;
    throw new Error("Payment gateway 503 Unavailable");
  }

  @DfsmEffect("notifyOpsTeam")
  notifyOps(req: EffectRequest<SagaBookingContext>): void {
    this.opsAlerts.push(`Ops alerted for tx ${req.transactionId}`);
  }
}

export async function runExample04PolicyMergeAndSagaCompensation() {
  const logger = new InMemoryBenchmarkLogger();
  const registry = new FSMRegistry({ logEngine: logger });
  const service = new TravelSagaService();

  registry.registerService(service, "travel.saga");
  registry.registerYaml(SAGA_POLICY_MERGE_YAML);

  const actor = await registry.createActor<SagaBookingContext>("travel-saga-policy-merge");

  // Verify normalized policy merge (`retry: 4` from Decorator + `circuitBreaker: true` from YAML)
  const effectivePayConfig = registry
    .getEffectiveConfig("travel-saga-policy-merge")
    .transitions.find((t) => t.event === "PAY")!;

  const txId = await actor.startTransaction({
    flightBooked: false,
    hotelBooked: false,
    paymentCharged: false,
    compensationTrail: [],
  });

  await actor.transition(txId, "BOOK_FLIGHT");
  await actor.transition(txId, "BOOK_HOTEL");

  // PAY fails all 4 attempts -> triggers LIFO compensation (cancelHotel -> cancelFlight)
  // AND routes to Decorator's onFail.target = "manual_escalation"!
  const payOutcome = await actor.transition(txId, "PAY");

  // Transition to overridden 'error' state and then recover via RESET_SAGA
  const errStep = await actor.transition(txId, "ESCALATE_TO_ERROR");
  const recoveredStep = await actor.transition(txId, "RESET_SAGA");

  await registry.shutdown();

  return {
    mergedMaxAttempts: effectivePayConfig.policy.retry.maxAttempts,
    mergedCircuitBreakerEnabled: effectivePayConfig.policy.circuitBreaker.enabled,
    mergedOnFailTarget: effectivePayConfig.policy.onFail.target,
    actualChargeAttempts: service.chargeAttempts,
    payOutcomeState: payOutcome.currentState,
    payOutcomeStatus: payOutcome.status,
    compensationOrder: payOutcome.context.compensationTrail,
    flightBookedAfterRollback: payOutcome.context.flightBooked,
    hotelBookedAfterRollback: payOutcome.context.hotelBooked,
    errorOverrideState: errStep.currentState,
    recoveredState: recoveredStep.currentState,
    opsAlerts: service.opsAlerts,
    benchmarkEntriesCount: logger.entries.length,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExample04PolicyMergeAndSagaCompensation().then((res) => {
    console.log("Example 04 Result:", JSON.stringify(res, null, 2));
  });
}

