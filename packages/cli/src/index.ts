#!/usr/bin/env node

import { Command } from 'commander'
import { loadConfig } from './config/loadConfig.js'
import { lintCommand } from './commands/lint.js'
import { compileCommand } from './commands/compile.js'
import {
  migrateUpCommand,
  migrateDownCommand,
  migrateStatusCommand,
} from './commands/migrate.js'

const program = new Command()
  .name('dfsm')
  .description('Durable finite state machine CLI')
  .version('0.1.0')

program
  .command('lint')
  .description('Lint machine configurations')
  .option('--machine <id>', 'Lint a specific machine')
  .action(async (opts) => {
    const config = await loadConfig(process.cwd())
    const ok = await lintCommand(config.machines, opts.machine)
    if (!ok) process.exit(1)
  })

program
  .command('compile')
  .description('Compile machines and generate interfaces')
  .option('--machine <id>', 'Compile a specific machine')
  .action(async (opts) => {
    const config = await loadConfig(process.cwd())
    await compileCommand(
      config.machines,
      config.generatedDir,
      process.cwd(),
      opts.machine,
    )
  })

const migrate = program
  .command('migrate')
  .description('Machine version migration commands')

migrate
  .command('up')
  .description('Migrate machine(s) to latest compiled version')
  .option('--machine <id>', 'Migrate a specific machine')
  .action(async (opts) => {
    const config = await loadConfig(process.cwd())
    await migrateUpCommand(
      config.machines,
      config.mongoUri,
      config.generatedDir,
      process.cwd(),
      opts.machine,
    )
  })

migrate
  .command('down')
  .description('Roll back machine(s) to previous version')
  .option('--machine <id>', 'Roll back a specific machine')
  .action(async (opts) => {
    const config = await loadConfig(process.cwd())
    await migrateDownCommand(
      config.machines,
      config.mongoUri,
      opts.machine,
    )
  })

migrate
  .command('status')
  .description('Show migration status for all machines')
  .action(async () => {
    const config = await loadConfig(process.cwd())
    await migrateStatusCommand(config.mongoUri)
  })

program
  .command('viz')
  .description('Launch the statechart visualiser')
  .option('--port <n>', 'Server port', '4242')
  .option('--machine <id>', 'Visualise a specific machine')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10)
    const { vizCommand } = await import('./commands/viz.js')
    await vizCommand(port, opts.machine)
  })

program.parse()
