export interface MachineTemplateOption {
  id: string;
  label: string;
  description: string;
  detail: string;
  content: string;
}

export const DFSM_TEMPLATES: MachineTemplateOption[] = [
  {
    id: 'saga-checkout',
    label: 'Resilient Saga Workflow',
    description: 'Multi-step Saga with LIFO compensation, retry/backoff, and circuit breaker',
    detail: 'Ideal for distributed transactions (orders, payments, bookings)',
    content: `# yaml-language-server: $schema=./schemas/dfsm-v1.schema.json
dfsm: "1.0"
id: order-checkout-saga
version: "1.0.0"
description: Multi-step durable checkout Saga with LIFO compensation on failure
initial: reserve_inventory

registry:
  namespace: "commerce.checkout"
  strict: true

defaults:
  retry:
    maxAttempts: 3
    backoff:
      strategy: exponential
      initialDelayMs: 100
      maxDelayMs: 5000
      multiplier: 2
  onFail:
    compensate: true
    target: error

states:
  reserve_inventory:
    entry: [logCheckoutStarted]
    on:
      INVENTORY_RESERVED:
        target: charge_payment
        transition: reserveItems
        compensate: releaseItems

  charge_payment:
    on:
      PAYMENT_CHARGED:
        target: schedule_shipment
        transition: capturePayment
        compensate: refundPayment
        circuitBreaker:
          enabled: true
          failureThreshold: 5
          slidingWindowSize: 10
          openDurationMs: 30000
          halfOpenMaxCalls: 1

  schedule_shipment:
    on:
      SHIPMENT_BOOKED:
        target: completed
        transition: bookCarrier
        effects: [sendConfirmationEmail]

  completed:
    type: final
`
  },
  {
    id: 'compound-hierarchy',
    label: 'Hierarchical Compound Statechart',
    description: 'Nested parent/child states with event bubbling and automatic onDone transition',
    detail: 'Ideal for phased lifecycles with shared parent CANCEL / TIMEOUT handlers',
    content: `# yaml-language-server: $schema=./schemas/dfsm-v1.schema.json
dfsm: "1.0"
id: payment-authorization
version: "1.0.0"
description: Hierarchical compound statechart with event bubbling and onDone completion
initial: processing

registry:
  namespace: "payments.auth"
  strict: true

states:
  processing:
    type: compound
    initial: validating
    entry: [openAuditSpan]
    exit: [closeAuditSpan]
    on:
      CANCEL:
        target: cancelled
        transition: recordCancellation
    onDone:
      target: settled
      effects: [emitSettledEvent]
    states:
      validating:
        on:
          VALIDATED:
            target: capturing
            transition: validateCard
      capturing:
        on:
          CAPTURED:
            target: done
            transition: captureFunds
      done:
        type: final

  settled:
    type: final

  cancelled:
    type: final
`
  },
  {
    id: 'parallel-regions',
    label: 'Orthogonal Parallel Regions',
    description: 'Concurrent child state regions synchronized via automatic onDone join',
    detail: 'Ideal for concurrent fulfillment, KYC checks, or multi-approval pipelines',
    content: `# yaml-language-server: $schema=./schemas/dfsm-v1.schema.json
dfsm: "1.0"
id: parallel-fulfillment
version: "1.0.0"
description: Orthogonal parallel billing and warehouse regions joining on completion
initial: created

registry:
  namespace: "logistics.fulfillment"
  strict: true

states:
  created:
    on:
      START:
        target: fulfilling
        transition: initializeOrder

  fulfilling:
    type: parallel
    onDone:
      target: dispatched
      effects: [notifyCustomerShipped]
    states:
      billing:
        initial: awaiting_capture
        states:
          awaiting_capture:
            on:
              CHARGE_OK:
                target: paid
                transition: settleInvoice
          paid:
            type: final
      warehouse:
        initial: picking
        states:
          picking:
            on:
              PACKED:
                target: ready_to_ship
                transition: confirmPackage
          ready_to_ship:
            type: final

  dispatched:
    type: final
`
  },
  {
    id: 'custom-error-override',
    label: 'Custom Error Recovery Override',
    description: 'Overrides built-in final error state with alerting and RECOVER transition',
    detail: 'Ideal for workflows supporting manual operator retry or dead-letter recovery',
    content: `# yaml-language-server: $schema=./schemas/dfsm-v1.schema.json
dfsm: "1.0"
id: resilient-connector
version: "1.0.0"
description: Custom states.error override with fallback queue and operator recovery
initial: ready

registry:
  namespace: "integrations.connector"
  strict: true

defaults:
  retry:
    maxAttempts: 3
  onFail:
    compensate: false
    target: error

states:
  ready:
    on:
      DISPATCH:
        target: delivered
        transition: callUpstreamWebhook
        circuitBreaker:
          enabled: true
          failureThreshold: 3
          slidingWindowSize: 6
          openDurationMs: 15000
          halfOpenMaxCalls: 1

  delivered:
    type: final

  error:
    description: Custom overridden error state allowing operator recovery
    entry: [notifyPagerDuty]
    on:
      RECOVER:
        target: ready
        transition: resetAttemptCounter
`
  }
];
