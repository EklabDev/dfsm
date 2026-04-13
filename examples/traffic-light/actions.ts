import type { ActionInput } from '@eklabdev/dfsm'

type Input = ActionInput<{ currentColour: string }>

export const trafficActions = new Map<string, (input: any) => Promise<any>>([
  [
    'logChange',
    async (input: Input) => {
      const colours: Record<string, string> = {
        red: 'green',
        green: 'yellow',
        yellow: 'red',
      }
      const next = colours[input.context.currentColour] ?? 'red'
      console.log(`Changed to ${next}`)
      return { currentColour: next }
    },
  ],
])
