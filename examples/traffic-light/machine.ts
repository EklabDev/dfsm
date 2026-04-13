import { z } from 'zod'
import { defineMachine } from '@eklabdev/dfsm'

export const trafficMachine = defineMachine({
  id: 'traffic',
  initial: 'red',
  terminal: [],
  context: { currentColour: 'red' },
  states: {
    red: {
      on: {
        NEXT: {
          target: 'green',
          actions: [
            {
              name: 'logChange',
              input: z.object({}),
              output: z.object({ currentColour: z.string() }),
            },
          ],
        },
      },
    },
    green: {
      on: {
        NEXT: {
          target: 'yellow',
          actions: [
            {
              name: 'logChange',
              input: z.object({}),
              output: z.object({ currentColour: z.string() }),
            },
          ],
        },
      },
    },
    yellow: {
      on: {
        NEXT: {
          target: 'red',
          actions: [
            {
              name: 'logChange',
              input: z.object({}),
              output: z.object({ currentColour: z.string() }),
            },
          ],
        },
      },
    },
  },
})
