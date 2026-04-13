import { execSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { MongoClient } from 'mongodb'
import { MongoStateStore } from '@eklabdev/dfsm'
import type { CompiledMachine, MachineConfig } from '@eklabdev/dfsm'
import { compile } from '@eklabdev/dfsm'
import chalk from 'chalk'

export async function migrateUpCommand(
  machines: MachineConfig[],
  mongoUri: string,
  generatedDir: string,
  cwd: string,
  machineId?: string,
): Promise<void> {
  const targets = machineId
    ? machines.filter((m) => m.id === machineId)
    : machines

  for (const machine of targets) {
    const artifactPath = resolve(cwd, '.dfsm', `${machine.id}.json`)
    if (!existsSync(artifactPath)) {
      console.error(
        chalk.red(
          `Artifact not found: ${artifactPath}. Run 'dfsm compile' first.`,
        ),
      )
      process.exit(1)
    }

    const name = machine.id.charAt(0).toUpperCase() + machine.id.slice(1)
    const interfacePath = resolve(cwd, generatedDir, `I${name}Actions.ts`)
    if (!existsSync(interfacePath)) {
      console.error(
        chalk.red(
          `Generated interface not found: ${interfacePath}. Run 'dfsm compile' first.`,
        ),
      )
      process.exit(1)
    }
  }

  // tsc gate
  try {
    execSync('npx tsc --noEmit', { cwd, stdio: 'pipe' })
  } catch (err: any) {
    console.error(chalk.red('TypeScript errors detected:'))
    console.error(err.stdout?.toString() ?? err.stderr?.toString() ?? '')
    console.error(
      chalk.red(
        'Implementation does not satisfy generated interface. Fix errors before migrating.',
      ),
    )
    process.exit(1)
  }

  const client = new MongoClient(mongoUri)
  try {
    await client.connect()
    const db = client.db()
    const store = new MongoStateStore(db)
    await store.setup()

    for (const machine of targets) {
      const artifactData = JSON.parse(
        readFileSync(resolve(cwd, '.dfsm', `${machine.id}.json`), 'utf-8'),
      )
      const compiled = compile(machine, artifactData.version)
      await store.saveMachineVersion(compiled)
      console.log(
        chalk.green(
          `Migrated ${machine.id} to v${artifactData.version}`,
        ),
      )
    }
  } finally {
    await client.close()
  }
}

export async function migrateDownCommand(
  machines: MachineConfig[],
  mongoUri: string,
  machineId?: string,
): Promise<void> {
  const targets = machineId
    ? machines.filter((m) => m.id === machineId)
    : machines

  const client = new MongoClient(mongoUri)
  try {
    await client.connect()
    const db = client.db()
    const store = new MongoStateStore(db)

    for (const machine of targets) {
      const active = await store.getActiveWorkflows(machine.id)
      if (active.length > 0) {
        console.error(
          chalk.red(
            `Cannot roll back ${machine.id}: ${active.length} active workflow(s). Drain before rolling back.`,
          ),
        )
        process.exit(1)
      }
      console.log(chalk.green(`Rolled back ${machine.id}`))
    }
  } finally {
    await client.close()
  }
}

export async function migrateStatusCommand(
  mongoUri: string,
): Promise<void> {
  const client = new MongoClient(mongoUri)
  try {
    await client.connect()
    const db = client.db()
    const registryDocs = await db
      .collection('machine_registry')
      .find()
      .toArray()

    const byMachine = new Map<string, any[]>()
    for (const doc of registryDocs) {
      const list = byMachine.get(doc.machineId) ?? []
      list.push(doc)
      byMachine.set(doc.machineId, list)
    }

    console.log(
      chalk.bold('machineId'.padEnd(20) + 'activeVersion'.padEnd(16) + 'deprecated'),
    )
    for (const [id, docs] of byMachine) {
      const active = docs.find((d) => d.status === 'active')
      const deprecated = docs
        .filter((d) => d.status === 'deprecated')
        .map((d) => `v${d.version}`)
        .join(', ')
      console.log(
        `${id.padEnd(20)}${active ? `v${active.version}` : 'none'.padEnd(16)}${deprecated || 'none'}`,
      )
    }
  } finally {
    await client.close()
  }
}
