import type { ActionInput } from '@eklabdev/dfsm'
import type { OrderContext } from '../machines/order.machine.js'

type Input = ActionInput<OrderContext>

export const orderActions = new Map<string, (input: any) => Promise<any>>([
  [
    'chargePayment',
    async (input: Input) => {
      console.log(`  Processing payment, history has ${input.history.length} prior transitions`)
      await sleep(200)
      return { chargeId: `ch_${Date.now()}` }
    },
  ],
  [
    'reserveStock',
    async (_input: Input) => {
      await sleep(100)
      return { reservationId: `rsv_${Date.now()}` }
    },
  ],
  [
    'sendShippingNotification',
    async (_input: Input) => {
      const tracking = 'TRK123'
      console.log(`  Shipping notification sent: ${tracking}`)
      return { trackingNumber: tracking }
    },
  ],
  [
    'processRefund',
    async (input: Input) => {
      console.log(`  Processing refund for charge ${input.context.chargeId}`)
      await sleep(150)
      return { refundId: `ref_${Date.now()}` }
    },
  ],
  [
    'recordCancellation',
    async (_input: Input) => ({ cancelReason: 'customer_request' }),
  ],
])

export const orderGuards = new Map<string, (input: any) => boolean>([
  ['hasStock', (input: Input) => input.context.sku !== 'OUT_OF_STOCK'],
])

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
