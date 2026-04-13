import { orderMachine } from './machines/order.machine.js'
import { OrderActions, OrderGuards } from './actions/order.actions.js'

export default {
  mongoUri: 'mongodb://localhost:27017/order-example',
  machines: [orderMachine],
  actions: new OrderActions(),
  guards: new OrderGuards(),
  generatedDir: './generated',
  leaseTtlMs: 30_000,
  outboxPollIntervalMs: 500,
}
