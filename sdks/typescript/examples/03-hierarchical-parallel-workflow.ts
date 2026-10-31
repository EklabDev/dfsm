import { FSMRegistry } from "../src/index.js";

export interface FulfillmentContext {
  paymentStatus: "unpaid" | "captured";
  warehouseStatus: "pending" | "packed";
  cancelledReason?: string;
  eventsLog: string[];
}

const HIERARCHICAL_PARALLEL_YAML = `
dfsm: "1.0"
id: fulfillment-orchestrator
version: "1.0.0"
initial: active_order

registry:
  namespace: "fulfillment"
  strict: true

states:
  active_order:
    initial: verifying
    exit: [onExitActiveOrder]
    # Parent-level transition handled via XState event bubbling from any nested child!
    on:
      CANCEL_ORDER:
        target: cancelled
        transition: recordCancellation
    states:
      verifying:
        on:
          VERIFIED:
            target: executing
            transition: logVerified

      executing:
        type: parallel
        onDone:
          target: dispatched
          effects: [onAllRegionsComplete]
        states:
          payment_region:
            initial: awaiting_capture
            states:
              awaiting_capture:
                on:
                  CAPTURE_PAYMENT:
                    target: payment_done
                    transition: markPaymentCaptured
              payment_done:
                type: final

          warehouse_region:
            initial: picking_items
            states:
              picking_items:
                on:
                  ITEMS_PACKED:
                    target: warehouse_done
                    transition: markWarehousePacked
              warehouse_done:
                type: final

  dispatched:
    type: final

  cancelled:
    type: final
`;

export async function runExample03HierarchicalParallelWorkflow() {
  const registry = new FSMRegistry();

  registry
    .registerTransition<FulfillmentContext>("fulfillment.logVerified", ({ context }) => ({
      context: { ...context.data, eventsLog: [...context.data.eventsLog, "verified"] },
    }))
    .registerTransition<FulfillmentContext>("fulfillment.markPaymentCaptured", ({ context }) => ({
      context: {
        ...context.data,
        paymentStatus: "captured",
        eventsLog: [...context.data.eventsLog, "payment_captured"],
      },
    }))
    .registerTransition<FulfillmentContext>("fulfillment.markWarehousePacked", ({ context }) => ({
      context: {
        ...context.data,
        warehouseStatus: "packed",
        eventsLog: [...context.data.eventsLog, "warehouse_packed"],
      },
    }))
    .registerTransition<FulfillmentContext, { reason: string }>(
      "fulfillment.recordCancellation",
      ({ input, context }) => ({
        context: {
          ...context.data,
          cancelledReason: input.reason,
          eventsLog: [...context.data.eventsLog, `cancelled:${input.reason}`],
        },
      })
    )
    .registerEffect<FulfillmentContext>("fulfillment.onExitActiveOrder", ({ context }) => {
      context.eventsLog.push("exit_active_order");
    })
    .registerEffect<FulfillmentContext>("fulfillment.onAllRegionsComplete", ({ context }) => {
      context.eventsLog.push("parallel_onDone_dispatched");
    });

  registry.registerYaml(HIERARCHICAL_PARALLEL_YAML);
  const actor = await registry.createActor<FulfillmentContext>("fulfillment-orchestrator");

  // Flow A: Happy path completing both parallel regions -> auto-triggers onDone -> 'dispatched'
  const txHappy = await actor.startTransaction({
    paymentStatus: "unpaid",
    warehouseStatus: "pending",
    eventsLog: [],
  });
  const afterVerify = await actor.transition(txHappy, "VERIFIED");
  const afterPayment = await actor.transition(txHappy, "CAPTURE_PAYMENT");
  const afterWarehouse = await actor.transition(txHappy, "ITEMS_PACKED");

  // Flow B: Cancel bubbles up from deep inside parallel region to parent 'active_order' -> 'cancelled'
  const txBubble = await actor.startTransaction({
    paymentStatus: "unpaid",
    warehouseStatus: "pending",
    eventsLog: [],
  });
  await actor.transition(txBubble, "VERIFIED");
  const afterCancelBubble = await actor.transition(txBubble, "CANCEL_ORDER", {
    reason: "customer_request",
  });

  await registry.shutdown();

  return {
    parallelEnteredState: afterVerify.currentState,
    partialParallelState: afterPayment.currentState,
    completedState: afterWarehouse.currentState,
    completedStatus: afterWarehouse.status,
    bubbledCancelState: afterCancelBubble.currentState,
    bubbledCancelStatus: afterCancelBubble.status,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExample03HierarchicalParallelWorkflow().then((res) => {
    console.log("Example 03 Result:", JSON.stringify(res, null, 2));
  });
}

