import { z } from "zod";
import {
  CompensateWith,
  DfsmCompensate,
  DfsmEffect,
  DfsmHook,
  DfsmTransition,
  OnFail,
  Retry,
  type AfterTransitionHookEvent,
  type BeforeTransitionHookEvent,
  type CompensationRequest,
  type EffectRequest,
  type OnCompensateHookEvent,
  type OnCompleteHookEvent,
  type OnTerminalHookEvent,
  type OnTransactionStartHookEvent,
  type TransitionOutput,
  type TransitionRequest,
} from "../../src/index.js";

// ============================================================================
// Typed Domain Context & Per-Event Input Schemas (Zod)
// ============================================================================

export const OrderItemSchema = z.object({
  sku: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceCents: z.number().int().positive(),
});

export const OrderApiContextSchema = z.object({
  customerEmail: z.string().email(),
  items: z.array(OrderItemSchema),
  totalCents: z.number().int().nonnegative(),
  inventoryReserved: z.boolean(),
  autoApprovePayment: z.boolean().default(false),
  paymentAuthId: z.string().nullable(),
  boxWeightKg: z.number().nullable(),
  trackingNumber: z.string().nullable(),
  carrier: z.string().nullable(),
  auditLog: z.array(z.string()),
});

export type OrderApiContext = z.infer<typeof OrderApiContextSchema>;

export const SubmitOrderInputSchema = z.object({
  items: z.array(OrderItemSchema).min(1, "Order must contain at least 1 item"),
  /**
   * When `true`, the `evaluatePostReserveRouting` entry effect on `inventory_reserved`
   * routes into `autoAuthorizeWalletEffect`, which immediately calls
   * `req.actor.transition(req.transactionId, "AUTHORIZE_PAYMENT", ...)` to advance straight into `fulfilling`!
   */
  autoApprovePayment: z.boolean().optional().default(false),
});
export type SubmitOrderInput = z.infer<typeof SubmitOrderInputSchema>;

export const AuthorizePaymentInputSchema = z.object({
  paymentMethod: z.string().min(3),
  simulateFailure: z.boolean().optional().default(false),
});
export type AuthorizePaymentInput = z.infer<typeof AuthorizePaymentInputSchema>;

export const PackCompleteInputSchema = z.object({
  boxWeightKg: z.number().positive(),
});
export type PackCompleteInput = z.infer<typeof PackCompleteInputSchema>;

export const BookCarrierInputSchema = z.object({
  carrier: z.string().min(2),
  trackingNumber: z.string().min(3),
});
export type BookCarrierInput = z.infer<typeof BookCarrierInputSchema>;

// ============================================================================
// Decorated Transition, Compensation & Effect Service (`api.orders` namespace)
// ============================================================================

export interface RecordedLifecycleHookEntry {
  hook:
    | "onStart"
    | "beforeTransition"
    | "afterTransition"
    | "onCompensate"
    | "onComplete"
    | "onTerminal";
  transactionId: string;
  timestamp: number;
  summary: Record<string, unknown>;
}

export class OrderFulfillmentService {
  public readonly notifications: string[] = [];
  public readonly routingEvents: string[] = [];
  public readonly lifecycleHooksLog: RecordedLifecycleHookEntry[] = [];
  private readonly logEmitter?: (line: string) => void;

  constructor(logEmitter?: (line: string) => void) {
    this.logEmitter = logEmitter;
  }

  private recordHook(
    hook: RecordedLifecycleHookEntry["hook"],
    transactionId: string,
    summary: Record<string, unknown>
  ): void {
    const timestamp = Date.now();
    this.lifecycleHooksLog.push({ hook, transactionId, timestamp, summary });
    this.logEmitter?.(
      `[${new Date(timestamp).toISOString()}] [DFSM-HOOK] hook=${hook} | tx=${transactionId} | ${JSON.stringify(summary)}`
    );
  }

  @DfsmTransition({ name: "reserveInventory", inputValidator: SubmitOrderInputSchema })
  @CompensateWith("releaseInventory")
  async reserveInventory(
    req: TransitionRequest<OrderApiContext, SubmitOrderInput>
  ): Promise<TransitionOutput<OrderApiContext, { reservedSkus: number; totalCents: number }>> {
    const totalCents = req.input.items.reduce(
      (sum, item) => sum + item.quantity * item.unitPriceCents,
      0
    );

    return {
      context: {
        ...req.context.data,
        items: req.input.items,
        totalCents,
        inventoryReserved: true,
        autoApprovePayment: req.input.autoApprovePayment ?? false,
        auditLog: [
          ...req.context.data.auditLog,
          `inventory_reserved:totalCents=${totalCents}`,
        ],
      },
      value: {
        reservedSkus: req.input.items.length,
        totalCents,
      },
    };
  }

  @DfsmCompensate("releaseInventory")
  async releaseInventory(
    req: CompensationRequest<OrderApiContext, SubmitOrderInput>
  ): Promise<OrderApiContext> {
    return {
      ...req.currentContext,
      inventoryReserved: false,
      auditLog: [
        ...req.currentContext.auditLog,
        `compensated:releaseInventory(step=${req.stepSeq})`,
      ],
    };
  }

  @DfsmTransition({ name: "authorizePayment", inputValidator: AuthorizePaymentInputSchema })
  @Retry(3) // Overrides YAML's retry: 2 -> normalized to 3 total attempts!
  @CompensateWith("refundPayment")
  @OnFail({ compensate: true, target: "error" })
  async authorizePayment(
    req: TransitionRequest<OrderApiContext, AuthorizePaymentInput>
  ): Promise<TransitionOutput<OrderApiContext, { paymentAuthId: string }>> {
    if (req.input.simulateFailure) {
      throw new Error(
        `Payment gateway declined '${req.input.paymentMethod}' on attempt ${req.context.attempt}`
      );
    }

    const paymentAuthId = `AUTH-${req.context.transactionId.slice(0, 8)}-${req.input.paymentMethod}`;
    return {
      context: {
        ...req.context.data,
        paymentAuthId,
        auditLog: [...req.context.data.auditLog, `payment_authorized:${paymentAuthId}`],
      },
      value: { paymentAuthId },
    };
  }

  @DfsmCompensate("refundPayment")
  async refundPayment(req: CompensationRequest<OrderApiContext>): Promise<OrderApiContext> {
    return {
      ...req.currentContext,
      paymentAuthId: null,
      auditLog: [
        ...req.currentContext.auditLog,
        `compensated:refundPayment(step=${req.stepSeq})`,
      ],
    };
  }

  @DfsmTransition({ name: "completePacking", inputValidator: PackCompleteInputSchema })
  async completePacking(
    req: TransitionRequest<OrderApiContext, PackCompleteInput>
  ): Promise<TransitionOutput<OrderApiContext, { packed: boolean }>> {
    return {
      context: {
        ...req.context.data,
        boxWeightKg: req.input.boxWeightKg,
        auditLog: [...req.context.data.auditLog, `packed:${req.input.boxWeightKg}kg`],
      },
      value: { packed: true },
    };
  }

  @DfsmTransition({ name: "bookShippingCarrier", inputValidator: BookCarrierInputSchema })
  async bookShippingCarrier(
    req: TransitionRequest<OrderApiContext, BookCarrierInput>
  ): Promise<TransitionOutput<OrderApiContext, { trackingNumber: string }>> {
    return {
      context: {
        ...req.context.data,
        carrier: req.input.carrier,
        trackingNumber: req.input.trackingNumber,
        auditLog: [
          ...req.context.data.auditLog,
          `carrier_booked:${req.input.carrier}:${req.input.trackingNumber}`,
        ],
      },
      value: { trackingNumber: req.input.trackingNumber },
    };
  }

  @DfsmTransition("cancelDraftOrder")
  async cancelDraftOrder(
    req: TransitionRequest<OrderApiContext, { reason?: string }>
  ): Promise<TransitionOutput<OrderApiContext>> {
    return {
      context: {
        ...req.context.data,
        auditLog: [
          ...req.context.data.auditLog,
          `cancelled_draft:${req.input?.reason ?? "user_cancelled"}`,
        ],
      },
    };
  }

  @DfsmTransition("cancelReservedOrder")
  async cancelReservedOrder(
    req: TransitionRequest<OrderApiContext, { reason?: string }>
  ): Promise<TransitionOutput<OrderApiContext>> {
    return {
      context: {
        ...req.context.data,
        inventoryReserved: false,
        auditLog: [
          ...req.context.data.auditLog,
          `cancelled_reserved_stock_released:${req.input?.reason ?? "user_cancelled"}`,
        ],
      },
    };
  }

  @DfsmTransition("resetAfterError")
  async resetAfterError(
    req: TransitionRequest<OrderApiContext>
  ): Promise<TransitionOutput<OrderApiContext>> {
    return {
      context: {
        ...req.context.data,
        items: [],
        totalCents: 0,
        inventoryReserved: false,
        autoApprovePayment: false,
        paymentAuthId: null,
        auditLog: [...req.context.data.auditLog, "reset_to_created"],
      },
    };
  }

  /**
   * Conditional router `@DfsmEffect` declared on `inventory_reserved.entry`:
   * demonstrates `if / else` branching via `req.runEffect(...)` + automatic next-step
   * transition on the same actor via `req.actor.transition(...)`!
   */
  @DfsmEffect("evaluatePostReserveRouting")
  async onInventoryReservedEntry(req: EffectRequest<OrderApiContext>): Promise<void> {
    if (req.context.autoApprovePayment) {
      await req.runEffect("autoAuthorizeWalletEffect", { paymentMethod: "express_auto_wallet" });
    } else {
      await req.runEffect("awaitManualPaymentEffect");
    }
  }

  @DfsmEffect("autoAuthorizeWalletEffect")
  async onAutoAuthorizeWallet(req: EffectRequest<OrderApiContext>): Promise<void> {
    const method =
      (req.payload as { paymentMethod?: string } | undefined)?.paymentMethod ??
      "express_auto_wallet";
    this.routingEvents.push(`auto_authorize_triggered:${req.transactionId}:${method}`);
    await req.actor.transition(req.transactionId, "AUTHORIZE_PAYMENT", {
      paymentMethod: method,
      simulateFailure: false,
    });
  }

  @DfsmEffect("awaitManualPaymentEffect")
  onAwaitManualPayment(req: EffectRequest<OrderApiContext>): void {
    this.routingEvents.push(`awaiting_manual_payment:${req.transactionId}`);
  }

  @DfsmEffect("sendDeliveryNotification")
  onDelivered(req: EffectRequest<OrderApiContext>): void {
    this.notifications.push(
      `Delivered notification sent to ${req.context.customerEmail} (tracking=${req.context.trackingNumber})`
    );
  }

  @DfsmEffect("recordErrorAlert")
  onError(req: EffectRequest<OrderApiContext>): void {
    this.notifications.push(`Error alert recorded for order tx=${req.transactionId}`);
  }

  // ==========================================================================
  // YAML-Bound Transaction Lifecycle Hooks (`hooks:` in order-fulfillment.dfsm.yaml)
  // ==========================================================================

  @DfsmHook("onOrderStarted")
  onOrderStarted(evt: OnTransactionStartHookEvent<OrderApiContext>): void {
    this.recordHook("onStart", evt.transactionId, {
      initialState: evt.initialState,
      status: evt.status,
    });
  }

  @DfsmHook("onBeforeOrderStep")
  onBeforeOrderStep(evt: BeforeTransitionHookEvent<OrderApiContext>): void {
    this.recordHook("beforeTransition", evt.transactionId, {
      event: evt.event,
      currentState: evt.currentState,
    });
  }

  @DfsmHook("onAfterOrderStep")
  onAfterOrderStep(evt: AfterTransitionHookEvent<OrderApiContext>): void {
    this.recordHook("afterTransition", evt.transactionId, {
      event: evt.event,
      previousState: evt.previousState,
      currentState: evt.currentState,
      status: evt.status,
      compensatedSteps: evt.compensatedSteps,
    });
  }

  @DfsmHook("onOrderCompensated")
  onOrderCompensated(evt: OnCompensateHookEvent<OrderApiContext>): void {
    this.recordHook("onCompensate", evt.transactionId, {
      stepSeq: evt.stepSeq,
      compensateHandler: evt.compensateHandler,
      fromState: evt.fromState,
    });
  }

  @DfsmHook("onOrderCompleted")
  onOrderCompleted(evt: OnCompleteHookEvent<OrderApiContext>): void {
    this.recordHook("onComplete", evt.transactionId, {
      finalState: evt.finalState,
    });
  }

  @DfsmHook("onOrderTerminal")
  onOrderTerminal(evt: OnTerminalHookEvent<OrderApiContext>): void {
    this.recordHook("onTerminal", evt.transactionId, {
      finalState: evt.finalState,
      status: evt.status,
      ...(evt.error ? { error: evt.error } : {}),
    });
  }
}

