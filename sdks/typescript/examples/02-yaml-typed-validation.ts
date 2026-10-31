import { z } from "zod";
import {
  DfsmEffect,
  DfsmTransition,
  FSMRegistry,
  ValidationError,
  type EffectRequest,
  type TransitionOutput,
  type TransitionRequest,
} from "../src/index.js";

// Strongly-typed Context & Input schemas owned in TypeScript code (not untyped YAML)
export const OrderContextSchema = z.object({
  orderId: z.string().min(3),
  itemsCount: z.number().int().nonnegative(),
  totalCents: z.number().int().nonnegative(),
  approvedBy: z.string().nullable(),
});

export type OrderContext = z.infer<typeof OrderContextSchema>;

export const SubmitItemsInputSchema = z.object({
  itemsCount: z.number().int().positive("Must include at least 1 item"),
  unitPriceCents: z.number().int().positive("Unit price must be > 0"),
});

export type SubmitItemsInput = z.infer<typeof SubmitItemsInputSchema>;

const ORDER_YAML = `
dfsm: "1.0"
id: typed-order-workflow
version: "1.0.0"
initial: draft

registry:
  namespace: "shop.orders"
  strict: true

states:
  draft:
    on:
      SUBMIT:
        target: pending_approval
        transition: submitItems

  pending_approval:
    on:
      APPROVE:
        target: confirmed
        transition: approveOrder

  confirmed:
    entry: [notifyConfirmation]
    type: final
`;

class OrderWorkflowHandlers {
  public readonly notifications: string[] = [];

  @DfsmTransition({ name: "submitItems", inputValidator: SubmitItemsInputSchema })
  async submitItems(
    req: TransitionRequest<OrderContext, SubmitItemsInput>
  ): Promise<TransitionOutput<OrderContext, { calculatedTotalCents: number }>> {
    const calculatedTotalCents = req.input.itemsCount * req.input.unitPriceCents;
    return {
      context: {
        ...req.context.data,
        itemsCount: req.input.itemsCount,
        totalCents: calculatedTotalCents,
      },
      value: { calculatedTotalCents },
    };
  }

  @DfsmTransition("approveOrder")
  async approveOrder(
    req: TransitionRequest<OrderContext, { approver: string }>
  ): Promise<TransitionOutput<OrderContext, boolean>> {
    return {
      context: {
        ...req.context.data,
        approvedBy: req.input.approver,
      },
      value: true,
    };
  }

  @DfsmEffect("notifyConfirmation")
  onConfirmed(req: EffectRequest<OrderContext>): void {
    this.notifications.push(`Order ${req.context.orderId} confirmed for ${req.context.totalCents}c`);
  }
}

export async function runExample02YamlTypedValidation() {
  const registry = new FSMRegistry();
  const handlers = new OrderWorkflowHandlers();

  registry.registerService(handlers, "shop.orders");
  registry.registerYaml(ORDER_YAML);

  const orderActor = await registry.createActor<OrderContext>("typed-order-workflow", {
    contextValidator: OrderContextSchema,
  });

  const txId = await orderActor.startTransaction({
    orderId: "ORD-900",
    itemsCount: 0,
    totalCents: 0,
    approvedBy: null,
  });

  // 1. Attempt invalid input (itemsCount = 0) -> rejected immediately before transition runs!
  let rejectedInvalidInput = false;
  try {
    await orderActor.transition(txId, "SUBMIT", { itemsCount: 0, unitPriceCents: 500 });
  } catch (err) {
    if (err instanceof ValidationError && err.target === "input") {
      rejectedInvalidInput = true;
    }
  }

  // State remains untouched in 'draft'
  const snapAfterInvalid = await orderActor.getTransaction(txId);

  // 2. Valid input advances cleanly
  const submitRes = await orderActor.transition<SubmitItemsInput, { calculatedTotalCents: number }>(
    txId,
    "SUBMIT",
    { itemsCount: 3, unitPriceCents: 1200 }
  );

  const approveRes = await orderActor.transition(txId, "APPROVE", { approver: "mgr-jane" });

  await registry.shutdown();

  return {
    rejectedInvalidInput,
    stateAfterInvalidAttempt: snapAfterInvalid?.stateValue,
    calculatedTotalCents: submitRes.value?.calculatedTotalCents,
    finalState: approveRes.currentState,
    finalStatus: approveRes.status,
    finalContext: approveRes.context,
    notifications: handlers.notifications,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runExample02YamlTypedValidation().then((res) => {
    console.log("Example 02 Result:", JSON.stringify(res, null, 2));
  });
}

