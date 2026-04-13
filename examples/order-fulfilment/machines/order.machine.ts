import { z } from 'zod'
import { defineMachine } from '@eklabdev/dfsm'

export interface OrderContext {
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

export const orderMachine = defineMachine<OrderContext>({
  id: 'order',
  initial: 'pending',
  terminal: ['delivered', 'cancelled', 'refunded'],
  context: { orderId: '', customerId: '', amount: 0, sku: '' },
  states: {
    pending: {
      on: {
        SUBMIT: {
          target: 'payment_processing',
          guard: { name: 'hasStock', input: z.object({ sku: z.string() }) },
          actions: [
            {
              name: 'chargePayment',
              input: z.object({ amount: z.number(), customerId: z.string() }),
              output: z.object({ chargeId: z.string() }),
            },
          ],
        },
        CANCEL: {
          target: 'cancelled',
          actions: [
            {
              name: 'recordCancellation',
              input: z.object({ orderId: z.string() }),
              output: z.object({ cancelReason: z.string() }),
            },
          ],
        },
      },
    },
    payment_processing: {
      after: { 300000: 'cancelled' },
      on: {
        PAYMENT_CAPTURED: {
          target: 'fulfilling',
          actions: [
            {
              name: 'reserveStock',
              input: z.object({ sku: z.string() }),
              output: z.object({ reservationId: z.string() }),
            },
          ],
        },
        PAYMENT_FAILED: { target: 'cancelled', actions: [] },
      },
    },
    fulfilling: {
      after: { 86400000: 'cancelled' },
      on: {
        SHIPPED: {
          target: 'shipped',
          actions: [
            {
              name: 'sendShippingNotification',
              input: z.object({ customerId: z.string(), orderId: z.string() }),
              output: z.object({ trackingNumber: z.string() }),
            },
          ],
        },
        CANCEL: { target: 'cancelled', actions: [] },
      },
    },
    shipped: {
      after: { 604800000: 'delivered' },
      on: {
        DELIVERED: { target: 'delivered', actions: [] },
        RETURN_REQUESTED: {
          target: 'refunded',
          actions: [
            {
              name: 'processRefund',
              input: z.object({ chargeId: z.string() }),
              output: z.object({ refundId: z.string() }),
            },
          ],
        },
      },
    },
    delivered: {},
    cancelled: {},
    refunded: {},
  },
})
