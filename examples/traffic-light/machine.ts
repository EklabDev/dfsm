import { createMachine } from '@eklabdev/dfsm'

export const trafficMachine = createMachine({
  id: 'traffic',
  initial: 'red',
  context: { currentColour: 'red' },
  states: {
    red: {
      on: {
        NEXT: {
          target: 'green',
          actions: ['logChange'],
        },
      },
    },
    green: {
      on: {
        NEXT: {
          target: 'yellow',
          actions: ['logChange'],
        },
      },
    },
    yellow: {
      on: {
        NEXT: {
          target: 'red',
          actions: ['logChange'],
        },
      },
    },
  },
})
