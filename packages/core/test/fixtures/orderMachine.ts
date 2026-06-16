import { z } from 'zod'
import { createMachine } from '../../src/machine/createMachine.js'

export interface OrderContext extends Record<string, unknown> {
  orderId: string
  customerId: string
  amount: number
  sku: string
  chargeId?: string
  reservationId?: string
  trackingNumber?: string
  cancelReason?: string
  refundId?: string
}

export const orderMachine = createMachine({
  id: 'order',
  initial: 'pending',
  context: { orderId: '', customerId: '', amount: 0, sku: '' },
  types: {} as {
    context: OrderContext
    events:
      | { type: 'SUBMIT' }
      | { type: 'PAYMENT_CAPTURED' }
      | { type: 'CANCEL' }
  },
  states: {
    pending: {
      on: {
        SUBMIT: {
          target: 'payment_processing',
          guard: 'hasStock',
          actions: ['chargePayment'],
          meta: {
            dfsm: {
              guard: { hasStock: { input: z.object({ sku: z.string() }) } },
              actions: {
                chargePayment: {
                  input: z.object({ amount: z.number(), customerId: z.string() }),
                  output: z.object({ chargeId: z.string() }),
                },
              },
            },
          },
        },
        CANCEL: {
          target: 'cancelled',
          actions: ['recordCancellation'],
          meta: {
            dfsm: {
              actions: {
                recordCancellation: {
                  input: z.object({ orderId: z.string() }),
                  output: z.object({ cancelReason: z.string() }),
                },
              },
            },
          },
        },
      },
    },
    payment_processing: {
      after: { 300000: 'cancelled' },
      on: {
        PAYMENT_CAPTURED: {
          target: 'fulfilling',
          actions: ['reserveStock'],
          meta: {
            dfsm: {
              actions: {
                reserveStock: {
                  input: z.object({ sku: z.string() }),
                  output: z.object({ reservationId: z.string() }),
                },
              },
            },
          },
        },
        PAYMENT_FAILED: { target: 'cancelled' },
      },
    },
    fulfilling: {
      after: { 86400000: 'cancelled' },
      on: {
        SHIPPED: {
          target: 'shipped',
          actions: ['sendShippingNotification'],
          meta: {
            dfsm: {
              actions: {
                sendShippingNotification: {
                  input: z.object({ customerId: z.string(), orderId: z.string() }),
                  output: z.object({ trackingNumber: z.string() }),
                },
              },
            },
          },
        },
        CANCEL: { target: 'cancelled' },
      },
    },
    shipped: {
      after: { 604800000: 'delivered' },
      on: {
        DELIVERED: { target: 'delivered' },
        RETURN_REQUESTED: {
          target: 'refunded',
          actions: ['processRefund'],
          meta: {
            dfsm: {
              actions: {
                processRefund: {
                  input: z.object({ chargeId: z.string() }),
                  output: z.object({ refundId: z.string() }),
                },
              },
            },
          },
        },
      },
    },
    delivered: { type: 'final' },
    cancelled: { type: 'final' },
    refunded: { type: 'final' },
  },
})
