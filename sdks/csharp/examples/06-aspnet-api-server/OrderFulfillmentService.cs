using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;
using EKLabDev.Dfsm;
using EKLabDev.Dfsm.Attributes;

namespace EKLabDev.Dfsm.SampleServer;

public class OrderFulfillmentService
{
    // --- Transitions & Compensations ---

    [DfsmTransition("reserveInventory")]
    [CompensateWith("releaseInventory")]
    public TransitionOutput<OrderApiContext, object> ReserveInventory(TransitionRequest<OrderApiContext, SubmitOrderInput> req)
    {
        var input = req.Input;
        decimal total = input.Items.Sum(i => i.UnitPrice * i.Quantity);
        var ctx = new OrderApiContext
        {
            OrderId = req.TransactionId,
            CustomerEmail = input.CustomerEmail,
            Items = input.Items,
            Priority = input.Priority,
            TotalAmount = total
        };
        Console.WriteLine($"[DFSM-STEP] Inventory reserved for tx={req.TransactionId}, total=${total}, priority={ctx.Priority}");
        return TransitionOutput<OrderApiContext, object>.Of(ctx, new { reservedSkus = input.Items.Count, totalAmount = total });
    }

    [DfsmCompensate("releaseInventory")]
    public void ReleaseInventory(CompensationRequest<OrderApiContext> req)
    {
        Console.WriteLine($"[DFSM-COMPENSATE] Released reserved inventory for tx={req.TransactionId}");
    }

    [DfsmTransition("authorizePayment")]
    [Retry(3)]
    [CompensateWith("refundPayment")]
    [OnFail(compensate: true, target: "error")]
    public TransitionOutput<OrderApiContext, object> AuthorizePayment(TransitionRequest<OrderApiContext, AuthorizePaymentInput> req)
    {
        var ctx = req.Data ?? new OrderApiContext { OrderId = req.TransactionId };
        ctx.PaymentAuthId = req.Input.PaymentAuthId;
        Console.WriteLine($"[DFSM-STEP] Payment authorized: authId={ctx.PaymentAuthId}");
        return TransitionOutput<OrderApiContext, object>.Of(ctx, new { paymentAuthId = ctx.PaymentAuthId });
    }

    [DfsmCompensate("refundPayment")]
    public void RefundPayment(CompensationRequest<OrderApiContext> req)
    {
        Console.WriteLine($"[DFSM-COMPENSATE] Refunded payment authId={req.Context?.PaymentAuthId} for tx={req.TransactionId}");
    }

    [DfsmTransition("completePacking")]
    public TransitionOutput<OrderApiContext, object> CompletePacking(TransitionRequest<OrderApiContext, CompletePackingInput> req)
    {
        var ctx = req.Data ?? new OrderApiContext { OrderId = req.TransactionId };
        ctx.BoxWeightKg = req.Input.BoxWeightKg;
        Console.WriteLine($"[DFSM-STEP] Warehouse packing complete: weight={ctx.BoxWeightKg}kg");
        return TransitionOutput<OrderApiContext, object>.Of(ctx, new { packed = true, weight = ctx.BoxWeightKg });
    }

    [DfsmTransition("bookShippingCarrier")]
    [Retry(3)]
    [OnFail(compensate: true, target: "error")]
    public TransitionOutput<OrderApiContext, object> BookShippingCarrier(TransitionRequest<OrderApiContext, BookCarrierInput> req)
    {
        if (req.Input.SimulateFailure)
        {
            Console.WriteLine($"[DFSM-STEP] Carrier API outage simulation: failed carrier booking for tx={req.TransactionId}");
            throw new Exception("Carrier API failed: Outage simulation.");
        }

        var ctx = req.Data ?? new OrderApiContext { OrderId = req.TransactionId };
        ctx.Carrier = req.Input.Carrier;
        ctx.TrackingNumber = req.Input.TrackingNumber;
        Console.WriteLine($"[DFSM-STEP] Carrier booked: carrier={ctx.Carrier}, tracking={ctx.TrackingNumber}");
        return TransitionOutput<OrderApiContext, object>.Of(ctx, new { trackingNumber = ctx.TrackingNumber, carrier = ctx.Carrier });
    }

    [DfsmTransition("cancelDraftOrder")]
    [DfsmTransition("cancelReservedOrder")]
    public TransitionOutput<OrderApiContext, object> CancelOrder(TransitionRequest<OrderApiContext, object> req)
    {
        Console.WriteLine($"[DFSM-STEP] Order cancelled for tx={req.TransactionId}");
        return TransitionOutput<OrderApiContext, object>.OfContext(req.Data);
    }

    [DfsmTransition("resetAfterError")]
    public TransitionOutput<OrderApiContext, object> ResetAfterError(TransitionRequest<OrderApiContext, object> req)
    {
        Console.WriteLine($"[DFSM-STEP] Reset order after error for tx={req.TransactionId}");
        return TransitionOutput<OrderApiContext, object>.OfContext(req.Data);
    }

    // --- Conditional Effects ---

    [DfsmEffect("evaluatePostReserveRouting")]
    public async Task EvaluatePostReserveRouting(EffectRequest<OrderApiContext> req)
    {
        var ctx = req.Context;
        Console.WriteLine($"[DFSM-EFFECT] evaluatePostReserveRouting for tx={req.TransactionId}, priority={ctx?.Priority}");
        if (ctx != null && ctx.Priority)
        {
            await req.RunEffectAsync("autoAuthorizeWalletEffect");
        }
        else
        {
            await req.RunEffectAsync("awaitManualPaymentEffect");
        }
    }

    [DfsmEffect("autoAuthorizeWalletEffect")]
    public async Task AutoAuthorizeWalletEffect(EffectRequest<OrderApiContext> req)
    {
        Console.WriteLine($"[DFSM-EFFECT] autoAuthorizeWalletEffect -> auto-transitioning AUTHORIZE_PAYMENT for tx={req.TransactionId}");
        await req.Actor.TransitionAsync(req.TransactionId, "AUTHORIZE_PAYMENT", new AuthorizePaymentInput
        {
            PaymentAuthId = "AUTH-VIP-WALLET"
        });
    }

    [DfsmEffect("awaitManualPaymentEffect")]
    public void AwaitManualPaymentEffect(EffectRequest<OrderApiContext> req)
    {
        Console.WriteLine($"[DFSM-EFFECT] awaitManualPaymentEffect: awaiting customer payment authorization for tx={req.TransactionId}");
    }

    [DfsmEffect("sendDeliveryNotification")]
    public void SendDeliveryNotification(EffectRequest<OrderApiContext> req)
    {
        Console.WriteLine($"[DFSM-EFFECT] sendDeliveryNotification: Order {req.TransactionId} delivered! Notification sent.");
    }

    [DfsmEffect("recordErrorAlert")]
    public void RecordErrorAlert(EffectRequest<OrderApiContext> req)
    {
        Console.WriteLine($"[DFSM-EFFECT] recordErrorAlert: Order {req.TransactionId} entered error state. Alert logged.");
    }

    // --- Lifecycle Hooks ---

    [DfsmHook(HookType.OnStart)]
    public void OnStart(ActorLifecycleEvents.OnStartEvent e)
    {
        Console.WriteLine($"[DFSM-HOOK] hook=onStart | tx={e.TransactionId} | initialState={e.InitialState}");
    }

    [DfsmHook(HookType.BeforeTransition)]
    public void BeforeTransition(ActorLifecycleEvents.BeforeTransitionEvent e)
    {
        Console.WriteLine($"[DFSM-HOOK] hook=beforeTransition | tx={e.TransactionId} | currentState={e.CurrentState} | event={e.EventName}");
    }

    [DfsmHook(HookType.AfterTransition)]
    public void AfterTransition(ActorLifecycleEvents.AfterTransitionEvent e)
    {
        Console.WriteLine($"[DFSM-HOOK] hook=afterTransition | tx={e.TransactionId} | event={e.EventName} | currentState={e.CurrentState} | status={e.Status}");
    }

    [DfsmHook(HookType.OnCompensate)]
    public void OnCompensate(ActorLifecycleEvents.OnCompensateEvent e)
    {
        Console.WriteLine($"[DFSM-HOOK] hook=onCompensate | tx={e.TransactionId} | step={e.StepName} | remaining={e.StepsRemaining}");
    }

    [DfsmHook(HookType.OnComplete)]
    public void OnComplete(ActorLifecycleEvents.OnCompleteEvent e)
    {
        Console.WriteLine($"[DFSM-HOOK] hook=onComplete | tx={e.TransactionId} | finalState={e.FinalState}");
    }

    [DfsmHook(HookType.OnTerminal)]
    public void OnTerminal(ActorLifecycleEvents.OnTerminalEvent e)
    {
        Console.WriteLine($"[DFSM-HOOK] hook=onTerminal | tx={e.TransactionId} | finalState={e.FinalState} | status={e.Status}");
    }
}
