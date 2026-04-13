import chalk from 'chalk'

export async function vizCommand(port: number, _machineId?: string): Promise<void> {
  console.log(chalk.cyan(`Starting dfsm viz on http://localhost:${port}`))
  // Delegate to the viz package server
  const { startServer } = await import('dfsm-viz')
  await startServer(port)
}
