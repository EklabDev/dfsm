import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { compile as coreCompile, generateInterface } from '@eklabdev/dfsm'
import type { MachineConfig, CompiledMachine } from '@eklabdev/dfsm'
import chalk from 'chalk'
import { lintCommand } from './lint.js'

export async function compileCommand(
  machines: MachineConfig[],
  generatedDir: string,
  cwd: string,
  machineId?: string,
): Promise<CompiledMachine[]> {
  const targets = machineId
    ? machines.filter((m) => m.id === machineId)
    : machines

  const lintOk = await lintCommand(targets, machineId)
  if (!lintOk) {
    process.exit(1)
  }

  const results: CompiledMachine[] = []

  for (const machine of targets) {
    const version = 1 // TODO: query DB for current active version + 1
    const compiled = coreCompile(machine, version)
    results.push(compiled)

    const name = machine.id.charAt(0).toUpperCase() + machine.id.slice(1)
    const interfaceSource = generateInterface(compiled, machine)
    const interfacePath = resolve(cwd, generatedDir, `I${name}Actions.ts`)
    mkdirSync(dirname(interfacePath), { recursive: true })
    writeFileSync(interfacePath, interfaceSource)

    const artifactDir = resolve(cwd, '.dfsm')
    mkdirSync(artifactDir, { recursive: true })

    const serialisedTable: Record<string, any> = {}
    for (const [state, events] of compiled.transitionTable) {
      serialisedTable[state] = Object.fromEntries(events)
    }

    writeFileSync(
      resolve(artifactDir, `${machine.id}.json`),
      JSON.stringify(
        {
          machineId: compiled.machineId,
          version: compiled.version,
          transitionTable: serialisedTable,
          vizGraph: compiled.vizGraph,
          allActionSlots: compiled.allActionSlots.map((s) => s.name),
          allGuardSlots: compiled.allGuardSlots.map((s) => s.name),
        },
        null,
        2,
      ),
    )

    console.log(
      chalk.green(
        `Compiled ${machine.id} v${version} → ${interfacePath}`,
      ),
    )
    console.log(
      `  ${compiled.allActionSlots.length} action(s), ` +
        `${compiled.allGuardSlots.length} guard(s), ` +
        `${compiled.vizGraph.nodes.length} state(s), ` +
        `${compiled.vizGraph.edges.length} edge(s)`,
    )
  }

  return results
}
