from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Dict, List, Optional

from dfsm import (
    CompensationRequest,
    DfsmActor,
    EffectRequest,
    FSMRegistry,
    HookType,
    MemoryStateStore,
    PartialTransitionPolicy,
    RetryPolicy,
    StateStore,
    TransitionOutput,
    TransitionRequest,
    parse_yaml_machine,
)
from models import OrderContext


class OrderFulfillmentService:
    def __init__(self, store: Optional[StateStore] = None) -> None:
        yaml_path = Path(__file__).parent / "order-fulfillment.dfsm.yaml"
        with open(yaml_path, "r", encoding="utf-8") as f:
            self.yaml_content = f.read()

        self.machine = parse_yaml_machine(self.yaml_content)
        self.store = store or MemoryStateStore()
        self.registry = FSMRegistry().with_store(self.store)

        self._register_handlers()
        self.actor = DfsmActor[OrderContext](self.machine, self.registry, context_type=OrderContext)

    def _register_handlers(self) -> None:
        ns = "api.orders"

        # Transitions
        def reserve_inventory(
            req: TransitionRequest[OrderContext, Any]
        ) -> TransitionOutput[OrderContext, Any]:
            req.context.items_reserved = True
            req.context.trace_log.append("Stock reserved in warehouse")
            print(f"[DFSM-STEP] tx={req.transaction_id} | Items reserved in warehouse")
            return TransitionOutput(
                context=req.context,
                output={"reservedSkus": 1, "totalCents": int(req.context.amount * 100)},
            )

        def cancel_draft_order(
            req: TransitionRequest[OrderContext, Any]
        ) -> TransitionOutput[OrderContext, Any]:
            req.context.trace_log.append("Draft order cancelled")
            print(f"[DFSM-STEP] tx={req.transaction_id} | Draft order cancelled")
            return TransitionOutput(context=req.context)

        def authorize_payment(
            req: TransitionRequest[OrderContext, Any]
        ) -> TransitionOutput[OrderContext, Any]:
            if req.context.simulate_failure:
                print(
                    f"[DFSM-STEP] tx={req.transaction_id} | Simulating payment gateway failure!"
                )
                raise RuntimeError(
                    "Simulated payment gateway timeout: insufficient funds or processor unreachable"
                )
            req.context.payment_charged = True
            req.context.trace_log.append(f"Payment authorized: ${req.context.amount:.2f}")
            print(f"[DFSM-STEP] tx={req.transaction_id} | Payment authorized for ${req.context.amount:.2f}")
            return TransitionOutput(
                context=req.context,
                output={"authorized": True, "authCode": "AUTH-778899"},
            )

        def cancel_reserved_order(
            req: TransitionRequest[OrderContext, Any]
        ) -> TransitionOutput[OrderContext, Any]:
            req.context.trace_log.append("Reserved order cancelled")
            print(f"[DFSM-STEP] tx={req.transaction_id} | Reserved order cancelled")
            return TransitionOutput(context=req.context)

        def complete_packing(
            req: TransitionRequest[OrderContext, Any]
        ) -> TransitionOutput[OrderContext, Any]:
            req.context.pack_complete = True
            req.context.trace_log.append("Items packed")
            print(f"[DFSM-STEP] tx={req.transaction_id} | Items packed in warehouse")
            return TransitionOutput(context=req.context)

        def book_shipping_carrier(
            req: TransitionRequest[OrderContext, Any]
        ) -> TransitionOutput[OrderContext, Any]:
            req.context.carrier_booked = True
            req.context.trace_log.append("Shipping carrier booked")
            print(f"[DFSM-STEP] tx={req.transaction_id} | Carrier booked")
            return TransitionOutput(
                context=req.context,
                output={"trackingNumber": "TRK-990011"},
            )

        def reset_after_error(
            req: TransitionRequest[OrderContext, Any]
        ) -> TransitionOutput[OrderContext, Any]:
            req.context.simulate_failure = False
            req.context.trace_log.append("Order reset from error to draft")
            print(f"[DFSM-STEP] tx={req.transaction_id} | Reset after error")
            return TransitionOutput(context=req.context)

        # Register transitions with namespace
        self.registry.register_transition(f"{ns}.reserveInventory", reserve_inventory)
        self.registry.register_transition(f"{ns}.cancelDraftOrder", cancel_draft_order)
        # Note: authorizePayment has a 3-attempt retry policy in code decorator
        self.registry.register_transition(
            f"{ns}.authorizePayment",
            authorize_payment,
            policy=PartialTransitionPolicy.from_dict({"retry": {"maxAttempts": 3}}),
        )
        self.registry.register_transition(f"{ns}.cancelReservedOrder", cancel_reserved_order)
        self.registry.register_transition(f"{ns}.completePacking", complete_packing)
        self.registry.register_transition(f"{ns}.bookShippingCarrier", book_shipping_carrier)
        self.registry.register_transition(f"{ns}.resetAfterError", reset_after_error)

        # Compensations
        def release_inventory(req: CompensationRequest[OrderContext]) -> None:
            req.context.items_reserved = False
            req.context.trace_log.append("<< [Saga Rollback] Warehouse inventory released")
            print(f"[DFSM-SAGA] tx={req.transaction_id} | Released warehouse inventory")

        def refund_payment(req: CompensationRequest[OrderContext]) -> None:
            req.context.payment_charged = False
            req.context.trace_log.append("<< [Saga Rollback] Payment refunded")
            print(f"[DFSM-SAGA] tx={req.transaction_id} | Refunded payment")

        self.registry.register_compensate(f"{ns}.releaseInventory", release_inventory)
        self.registry.register_compensate(f"{ns}.refundPayment", refund_payment)

        # Effects
        async def evaluate_post_reserve_routing(req: EffectRequest[OrderContext]) -> None:
            if req.context.auto_authorize:
                await self.actor.run_effect(f"{ns}.autoAuthorizeWalletEffect", req.context)
                # Automatic next transition!
                asyncio.create_task(self.actor.transition(req.transaction_id, "AUTHORIZE_PAYMENT"))
            else:
                await self.actor.run_effect(f"{ns}.awaitManualPaymentEffect", req.context)

        def auto_authorize_wallet_effect(ctx: OrderContext) -> None:
            ctx.trace_log.append("Auto-authorizing customer wallet payment")
            print(f"[DFSM-EFFECT] Auto-authorizing payment for {ctx.customer}")

        def await_manual_payment_effect(ctx: OrderContext) -> None:
            ctx.trace_log.append("Awaiting manual payment submission")
            print(f"[DFSM-EFFECT] Awaiting manual payment for {ctx.customer}")

        def send_delivery_notification(req: EffectRequest[OrderContext]) -> None:
            req.context.trace_log.append("Order delivered! Notification sent to customer.")
            print(f"[DFSM-EFFECT] Delivery notification dispatched to {req.context.customer}")

        def record_error_alert(req: EffectRequest[OrderContext]) -> None:
            req.context.trace_log.append("Error alert recorded in telemetry")
            print(f"[DFSM-EFFECT] Error alert recorded for {req.transaction_id}")

        self.registry.register_effect(f"{ns}.evaluatePostReserveRouting", evaluate_post_reserve_routing)
        self.registry.register_effect(f"{ns}.autoAuthorizeWalletEffect", auto_authorize_wallet_effect)
        self.registry.register_effect(f"{ns}.awaitManualPaymentEffect", await_manual_payment_effect)
        self.registry.register_effect(f"{ns}.sendDeliveryNotification", send_delivery_notification)
        self.registry.register_effect(f"{ns}.recordErrorAlert", record_error_alert)

        # Lifecycle Hooks
        def on_order_started(payload: Any) -> None:
            print(f"[DFSM-HOOK:onStart] tx={payload.transaction_id} | initial={payload.initial_state}")

        def on_before_order_step(payload: Any) -> None:
            print(f"[DFSM-HOOK:beforeTransition] tx={payload.transaction_id} | event={payload.event_name} | current={payload.current_state}")

        def on_after_order_step(payload: Any) -> None:
            print(f"[DFSM-HOOK:afterTransition] tx={payload.transaction_id} | event={payload.event_name} -> {payload.current_state} (status={payload.status.value})")

        def on_order_compensated(payload: Any) -> None:
            print(f"[DFSM-HOOK:onCompensate] tx={payload.transaction_id} | step={payload.step_name} | remaining={payload.steps_remaining}")

        def on_order_completed(payload: Any) -> None:
            print(f"[DFSM-HOOK:onComplete] tx={payload.transaction_id} | final={payload.final_state} | v={payload.version}")

        def on_order_terminal(payload: Any) -> None:
            print(f"[DFSM-HOOK:onTerminal] tx={payload.transaction_id} | terminal={payload.final_state} | status={payload.status.value}")

        self.registry.register_hook(HookType.ON_START, on_order_started)
        self.registry.register_hook(HookType.BEFORE_TRANSITION, on_before_order_step)
        self.registry.register_hook(HookType.AFTER_TRANSITION, on_after_order_step)
        self.registry.register_hook(HookType.ON_COMPENSATE, on_order_compensated)
        self.registry.register_hook(HookType.ON_COMPLETE, on_order_completed)
        self.registry.register_hook(HookType.ON_TERMINAL, on_order_terminal)
