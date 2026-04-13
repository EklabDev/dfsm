import type { ActionInput } from '@eklabdev/dfsm'
import type { OrderContext } from '../machines/order.machine.js'

type Input = ActionInput<OrderContext>

export class OrderActions {
  async chargePayment(input: Input & { amount: number; customerId: string }) {
    console.log(`  Processing payment, history has ${input.history.length} prior transitions`)
    await sleep(200)
    return { chargeId: `ch_${Date.now()}` }
  }

  async reserveStock(input: Input & { sku: string }) {
    await sleep(100)
    return { reservationId: `rsv_${Date.now()}` }
  }

  async sendShippingNotification(input: Input & { customerId: string; orderId: string }) {
    const tracking = 'TRK123'
    console.log(`  Shipping notification sent: ${tracking}`)
    return { trackingNumber: tracking }
  }

  async processRefund(input: Input & { chargeId: string }) {
    console.log(`  Processing refund for charge ${input.context.chargeId}`)
    await sleep(150)
    return { refundId: `ref_${Date.now()}` }
  }

  async recordCancellation(_input: Input & { orderId: string }) {
    return { cancelReason: 'customer_request' }
  }
}

export class OrderGuards {
  hasStock(input: Input & { sku: string }): boolean {
    return input.context.sku !== 'OUT_OF_STOCK'
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
