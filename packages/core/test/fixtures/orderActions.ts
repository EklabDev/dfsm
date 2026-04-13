import type { ActionInput } from '../../src/types/context.js'
import type { OrderContext } from './orderMachine.js'

type Input = ActionInput<OrderContext>

export const orderActions = new Map<string, (input: any) => Promise<any>>([
  [
    'chargePayment',
    async (_input: Input) => ({ chargeId: `ch_test_${Date.now()}` }),
  ],
  [
    'reserveStock',
    async (_input: Input) => ({ reservationId: `rsv_test_${Date.now()}` }),
  ],
  [
    'sendShippingNotification',
    async (_input: Input) => ({ trackingNumber: 'TRK123' }),
  ],
  [
    'processRefund',
    async (_input: Input) => ({ refundId: `ref_test_${Date.now()}` }),
  ],
  [
    'recordCancellation',
    async (_input: Input) => ({ cancelReason: 'customer_request' }),
  ],
])

export const orderGuards = new Map<string, (input: any) => boolean>([
  ['hasStock', (input: Input) => input.context.sku !== 'OUT_OF_STOCK'],
])
